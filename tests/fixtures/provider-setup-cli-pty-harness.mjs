#!/usr/bin/env node

/**
 * Real command-to-setup PTY proof. Unlike provider-setup-pty-harness.mjs,
 * this fixture starts at the built cli.runCli() entrypoint and types the
 * owner's exact command. The only injected boundary is CliBootstrapDeps'
 * documented provider-runtime factory; that factory returns a real
 * DefaultProviderRuntime backed by local adapter/persistence fakes.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const SELECTED_MODEL_ID = "vendor/cli-selected";
const FIRST_MODEL_ID = "vendor/cli-first";
const SAFE_ACCOUNT_FINGERPRINT = "acct_or_cli_pty_owner_6f2a91";
const CONNECTION_ID = "71717171-7171-4171-8171-717171717171";
const CREDENTIAL_SLOT = "v1:inference:91919191-9191-4191-8191-919191919191";
const CREDENTIAL_PARTS = Object.freeze([
  "local-owner-",
  "provider-setup-",
  "credential-fixture",
]);

function syntheticCredential() {
  return CREDENTIAL_PARTS.join("");
}

const PYTHON_CONTROLLER = String.raw`
import base64
import errno
import fcntl
import hashlib
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time

config = json.loads(sys.argv[1])
master = -1
slave = -1
process = None
captured = bytearray()
deadline = time.monotonic() + (config["timeoutMs"] / 1000.0)
stage = "bootstrap"

def append_output(chunk):
    if not chunk:
        return
    if len(captured) + len(chunk) > config["maxOutputBytes"]:
        raise RuntimeError("output-limit")
    captured.extend(chunk)

def read_once(wait_seconds):
    remaining = max(0.0, deadline - time.monotonic())
    wait = min(wait_seconds, remaining)
    ready, _, _ = select.select([master], [], [], wait)
    if not ready:
        return False
    try:
        chunk = os.read(master, 8192)
    except OSError as error:
        if error.errno == errno.EIO:
            return False
        raise
    if not chunk:
        return False
    append_output(chunk)
    return True

def wait_for(marker):
    while marker not in captured:
        if time.monotonic() >= deadline:
            raise TimeoutError("marker-timeout")
        if process.poll() is not None and not read_once(0.0):
            raise RuntimeError("early-exit")
        read_once(0.05)

def wait_for_after(marker, offset):
    while marker not in captured[offset:]:
        if time.monotonic() >= deadline:
            raise TimeoutError("marker-after-timeout")
        if process.poll() is not None and not read_once(0.0):
            raise RuntimeError("early-exit")
        read_once(0.05)

def write_all(data):
    offset = 0
    while offset < len(data):
        offset += os.write(master, data[offset:])

def type_text(data):
    for byte in data:
        write_all(bytes([byte]))
        time.sleep(0.003)

def input_stage(attempt):
    return ('ORCODE_CLI_STAGE:{"stage":"input","attempt":' + str(attempt) + '}').encode("ascii")

def setup_stage(name, attempt):
    return ('ORCODE_CLI_STAGE:{"stage":"' + name + '","attempt":' + str(attempt) + '}').encode("ascii")

try:
    master, slave = os.openpty()
    size = struct.pack("HHHH", config["rows"], config["columns"], 0, 0)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
    environment = {
        "HOME": os.environ["HOME"],
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
        "ORCODE_ASCII": "1",
        "ORCODE_PROVIDER_CLI_MODULE": config["cliModuleUrl"],
        "ORCODE_PROVIDER_TUI_MODULE": config["tuiModuleUrl"],
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "TERM": "xterm-256color",
    }
    process = subprocess.Popen(
        [config["nodeExecutable"], config["harnessPath"], "child"],
        cwd=config["projectRoot"],
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave)
    slave = -1

    stage = "child ready"
    wait_for(b"ORCODE_CLI_READY:")
    stage = "first dashboard input"
    wait_for(input_stage(1))

    stage = "first exact provider setup command"
    type_text(b"/provider setup")
    write_all(b"\r")
    wait_for(setup_stage("hub", 1))
    write_all(b"\x1b")
    wait_for(b"Provider setup: cancelled")
    wait_for(input_stage(2))

    stage = "immediate exact provider setup retry"
    type_text(b"/provider setup")
    write_all(b"\r")
    wait_for(setup_stage("hub", 2))
    write_all(b"\r")

    stage = "explicit credential-bound account"
    wait_for(setup_stage("secret", 1))
    type_text(b"local-owner-provider-setup-credential-fixture")
    write_all(b"\r")

    stage = "explicit non-default model selection"
    wait_for(setup_stage("model", 1))
    write_all(b"\x1b[B")
    write_all(b"\r")

    stage = "explicit save confirmation"
    wait_for(setup_stage("confirm", 1))
    write_all(b"y")
    wait_for(b"Provider setup: ready")
    wait_for(input_stage(3))

    stage = "legacy bare provider command"
    type_text(b"/provider")
    write_all(b"\r")
    wait_for(input_stage(4))

    stage = "provider status command"
    type_text(b"/provider status")
    write_all(b"\r")
    wait_for(input_stage(5))

    stage = "invalid provider setup extra command"
    type_text(b"/provider setup extra")
    write_all(b"\r")
    wait_for(input_stage(6))

    stage = "clean dashboard exit"
    write_all(b"\x03")
    wait_for(b"Ctrl+C again closes orcode")
    write_all(b"\x03")
    wait_for(b"ORCODE_CLI_RESULT:")
    while process.poll() is None:
        if time.monotonic() >= deadline:
            raise TimeoutError("process-timeout")
        read_once(0.05)
    while read_once(0.0):
        pass
    sys.stdout.write(json.dumps({
        "exitCode": process.returncode,
        "forcedTermination": False,
        "outputBase64": base64.b64encode(bytes(captured)).decode("ascii"),
    }, separators=(",", ":")))
except Exception as error:
    sys.stdout.write(json.dumps({
        "controllerError": "provider-cli-pty-controller-failed",
        "stage": stage,
        "outputBytes": len(captured),
        "outputSha256": hashlib.sha256(bytes(captured)).hexdigest(),
    }, separators=(",", ":")))
    sys.exit(1)
finally:
    if slave >= 0:
        os.close(slave)
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=0.5)
        except Exception:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=0.5)
    if master >= 0:
        os.close(master)
`;

export async function runProviderSetupCliPtyScenario(options) {
  if ((options.platform ?? process.platform) === "win32") {
    const error = new Error("The command-to-setup transcript proof requires a POSIX PTY.");
    error.code = "provider-cli-pty-posix-unsupported";
    throw error;
  }
  const absoluteModuleRoot = resolve(options.projectRoot, options.moduleRoot);
  const request = {
    cliModuleUrl: pathToFileURL(join(absoluteModuleRoot, "cli.js")).href,
    columns: options.columns ?? DEFAULT_COLUMNS,
    harnessPath: relative(options.projectRoot, fileURLToPath(import.meta.url)),
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    nodeExecutable: process.execPath,
    projectRoot: options.projectRoot,
    rows: options.rows ?? DEFAULT_ROWS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tuiModuleUrl: pathToFileURL(join(absoluteModuleRoot, "tui.js")).href,
  };
  const isolatedHome = await mkdtemp(join(tmpdir(), "orcode-provider-cli-pty-home-"));
  let execution;
  let homeAudit;
  try {
    execution = await execFilePromise(
      options.pythonExecutable ?? "/usr/bin/python3",
      ["-c", PYTHON_CONTROLLER, JSON.stringify(request)],
      {
        cwd: options.projectRoot,
        encoding: "utf8",
        env: {
          HOME: isolatedHome,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          PYTHONDONTWRITEBYTECODE: "1",
        },
        maxBuffer: request.maxOutputBytes * 2,
        timeout: (options.controllerTimeoutMs ?? request.timeoutMs + 2_000),
      },
    );
    homeAudit = await auditIsolatedHome(isolatedHome);
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
  let controller;
  try {
    controller = JSON.parse(execution.stdout.trim());
  } catch {
    throw safeFailure("provider-cli-pty-controller-invalid", { execution, homeAudit });
  }
  if (execution.failed || controller.controllerError || controller.exitCode !== 0) {
    throw safeFailure(controller.controllerError ?? "provider-cli-pty-controller-failed", {
      controller,
      execution,
      homeAudit,
    });
  }
  const outputBytes = Buffer.from(controller.outputBase64, "base64");
  if (outputBytes.length === 0 || outputBytes.length > request.maxOutputBytes) {
    throw safeFailure("provider-cli-pty-output-invalid", { controller, execution, homeAudit });
  }
  const output = outputBytes.toString("utf8");
  if (output.includes(syntheticCredential())) {
    throw safeFailure("provider-cli-pty-secret-echoed", { controller, execution, homeAudit });
  }
  return {
    homeAudit,
    output,
    ready: lastJsonMarker(output, "ORCODE_CLI_READY:"),
    result: lastJsonMarker(output, "ORCODE_CLI_RESULT:"),
    forcedTermination: controller.forcedTermination === true,
  };
}

function jsonMarkers(output, marker) {
  const values = [];
  let offset = 0;
  while (offset < output.length) {
    const start = output.indexOf(marker, offset);
    if (start < 0) break;
    const valueStart = start + marker.length;
    const end = output.indexOf("\n", valueStart);
    const line = output.slice(valueStart, end < 0 ? output.length : end).replace(/\r$/, "");
    try { values.push(JSON.parse(line)); } catch { /* ignore partial redraw */ }
    offset = valueStart;
  }
  return values;
}

function lastJsonMarker(output, marker) {
  const values = jsonMarkers(output, marker);
  if (!values.length) throw new Error(`Provider CLI PTY output omitted ${marker}`);
  return values.at(-1);
}

function execFilePromise(file, args, options) {
  return new Promise((resolvePromise) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolvePromise({ failed: error !== null, stderr, stdout });
    });
  });
}

async function auditIsolatedHome(homeRoot) {
  let fileCount = 0;
  let totalBytes = 0;
  let credentialFindings = 0;
  const digest = createHash("sha256");
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        fileCount += 1;
        const bytes = await readFile(path);
        totalBytes += bytes.length;
        credentialFindings += bytes.includes(Buffer.from(syntheticCredential())) ? 1 : 0;
        digest.update(relative(homeRoot, path));
        digest.update(bytes);
      }
    }
  }
  await visit(homeRoot);
  return {
    credentialFindings,
    fileCount,
    sha256: digest.digest("hex"),
    totalBytes,
  };
}

function safeFailure(code, facts) {
  const error = new Error("The bounded command-to-provider-setup PTY scenario failed.");
  error.code = code;
  error.stage = facts.controller?.stage ?? null;
  error.outputBytes = facts.controller?.outputBytes ?? 0;
  error.outputSha256 = facts.controller?.outputSha256 ?? createHash("sha256").digest("hex");
  error.homeFileCount = facts.homeAudit?.fileCount ?? 0;
  error.homeCredentialFindings = facts.homeAudit?.credentialFindings ?? 0;
  return error;
}

async function runChildHarness() {
  const cliModuleUrl = process.env.ORCODE_PROVIDER_CLI_MODULE;
  const tuiModuleUrl = process.env.ORCODE_PROVIDER_TUI_MODULE;
  if (!cliModuleUrl || !tuiModuleUrl) throw new Error("Provider CLI proof modules are unavailable.");
  const cli = await import(cliModuleUrl);
  const tui = await import(tuiModuleUrl);
  const configModule = await import(new URL("./config.js", cliModuleUrl));
  const { SessionStore } = await import(new URL("./session.js", cliModuleUrl));
  const { RuleStore } = await import(new URL("./rules.js", cliModuleUrl));
  const { OpenRouterService } = await import(new URL("./openrouter.js", cliModuleUrl));
  const { BackendRegistry } = await import(new URL("./backends.js", cliModuleUrl));
  const { OPENROUTER_DESCRIPTOR, ANTHROPIC_COMING_SOON_DESCRIPTOR } = await import(
    new URL("./openrouter-backend.js", cliModuleUrl)
  );
  const { KIMI_CODE_DESCRIPTOR } = await import(new URL("./kimi-code-backend.js", cliModuleUrl));
  const { ProviderStateStore, createNeverConfiguredProviderState } = await import(
    new URL("./provider-state.js", cliModuleUrl)
  );
  const { SetupOrchestrator } = await import(new URL("./setup.js", cliModuleUrl));

  const root = await mkdtemp(join(tmpdir(), "orcode-provider-cli-pty-"));
  const workspace = join(root, "workspace");
  const appHome = join(root, "app");
  const configPath = join(appHome, "config.json");
  await mkdir(workspace, { recursive: true });
  await mkdir(appHome, { recursive: true });

  const persisted = structuredClone(configModule.DEFAULT_CONFIG);
  persisted.appearance = {
    ...persisted.appearance,
    glyphMode: "ascii",
    showLargeLogo: false,
  };
  persisted.providerSetup = createNeverConfiguredProviderState();
  await configModule.saveConfig(persisted, configPath);
  const session = SessionStore.create(workspace, appHome, "Provider setup PTY");
  const rules = await RuleStore.load(appHome);

  const commands = [];
  const providerIntents = [];
  const providerSelections = [];
  const modelSelections = [];
  const modelCatalogs = [];
  const secretEntries = [];
  const confirmations = [];
  const counters = {
    activation: 0,
    agent: 0,
    configWrites: 0,
    connect: 0,
    discard: 0,
    inspect: 0,
    kimi: 0,
    listModels: 0,
    network: 0,
    persistence: 0,
  };
  const credentialSlots = new Map();
  const credentialStore = {
    async get() { return null; },
    async set() {},
    async delete() { return false; },
    async has() { return false; },
    reserveSlot() { return CREDENTIAL_SLOT; },
    async writeSlot(pointer, value) { credentialSlots.set(pointer, value); },
    async readSlot(pointer) { return credentialSlots.get(pointer) ?? null; },
    async deleteSlot(pointer) { return credentialSlots.delete(pointer); },
    async getOrCreateAccountHmacKey() { return Buffer.alloc(32, 7); },
  };
  const models = [
    {
      backendId: "openrouter",
      requestedModelId: FIRST_MODEL_ID,
      canonicalModelId: FIRST_MODEL_ID,
      displayName: "CLI First Model",
      capabilities: { textInput: true, textOutput: true, tools: true, reasoning: false },
    },
    {
      backendId: "openrouter",
      requestedModelId: SELECTED_MODEL_ID,
      canonicalModelId: SELECTED_MODEL_ID,
      displayName: "CLI Selected Model",
      capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
    },
  ];
  const openRouterAdapter = {
    backendId: "openrouter",
    async inspect() { counters.inspect += 1; throw new Error("Unexpected local inspection."); },
    async connect(request) {
      counters.connect += 1;
      return {
        candidateId: "provider-cli-candidate",
        backendId: "openrouter",
        connectionId: CONNECTION_ID,
        accountFingerprint: SAFE_ACCOUNT_FINGERPRINT,
        billingRealm: "openrouter-payg",
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "available",
          runtime: "not-applicable",
          observedAt: 100,
          generation: request.generation,
        },
      };
    },
    async listModels() { counters.listModels += 1; return models; },
    async activate() { throw new Error("The local activation port owns activation."); },
    async reconnect() { throw new Error("Unexpected local reconnect."); },
    async logout() { throw new Error("Unexpected local logout."); },
    async discardCandidate() { counters.discard += 1; },
  };
  const kimiAdapter = {
    backendId: "kimi-code",
    async inspect() { counters.kimi += 1; throw new Error("Kimi is outside this local proof."); },
    async connect() { counters.kimi += 1; throw new Error("Kimi is outside this local proof."); },
    async listModels() { counters.kimi += 1; throw new Error("Kimi is outside this local proof."); },
    async activate() { counters.kimi += 1; throw new Error("Kimi is outside this local proof."); },
    async reconnect() { counters.kimi += 1; throw new Error("Kimi is outside this local proof."); },
    async logout() { counters.kimi += 1; throw new Error("Kimi is outside this local proof."); },
    async discardCandidate() { counters.kimi += 1; },
  };
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter: openRouterAdapter },
    { descriptor: KIMI_CODE_DESCRIPTOR, adapter: kimiAdapter },
    { descriptor: ANTHROPIC_COMING_SOON_DESCRIPTOR },
  ]);
  const stateStore = new ProviderStateStore(persisted.providerSetup, {
    persist: async (request) => {
      counters.persistence += 1;
      return cli.persistProviderSetupState(configPath, request);
    },
  });
  const semanticSnapshot = () => ({
    activationCount: counters.activation,
    configWriteCount: counters.configWrites,
    configMainModel: persisted.mainModel,
    connectCount: counters.connect,
    connectionCount: stateStore.read().connections.length,
    credentialSlotCount: credentialSlots.size,
    defaultRoute: stateStore.read().defaultRoute,
    modelListCount: counters.listModels,
    sessionRoute: session.data.route ?? null,
  });
  const activationCoordinator = {
    async activate(request) {
      counters.activation += 1;
      const pointer = credentialStore.reserveSlot("inference");
      await credentialStore.writeSlot(pointer, request.candidate);
      const route = {
        version: 1,
        backendId: "openrouter",
        accountFingerprint: SAFE_ACCOUNT_FINGERPRINT,
        billingRealm: "openrouter-payg",
        requestedModelId: request.expectedRequestedModelId,
        canonicalModelId: request.selectedCanonicalModelId,
        resolutionState: "resolved",
      };
      persisted.mainModel = request.expectedRequestedModelId;
      counters.configWrites += 1;
      await configModule.saveConfig(persisted, configPath);
      const committed = await stateStore.commit(request.expectedRevision, (current) => ({
        ...current,
        lifecycle: "configured",
        connections: [{
          id: CONNECTION_ID,
          backendId: "openrouter",
          enabled: true,
          maturity: "stable",
          credentialBinding: { kind: "orcode-keychain", pointer },
          accountFingerprint: SAFE_ACCOUNT_FINGERPRINT,
          accountFingerprintState: "verified",
          billingRealm: "openrouter-payg",
          lastHealth: {
            credential: "valid",
            connectivity: "connected",
            spend: "available",
            runtime: "not-applicable",
            observedAt: 100,
            generation: request.generation,
          },
        }],
        defaultRoute: route,
      }));
      return { persisted: true, route, state: committed, warnings: [] };
    },
  };
  const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator });
  const runtimeGuard = new cli.SessionProviderRuntimeGuard();
  const openRouter = new OpenRouterService(undefined);
  const providerCredentials = {
    async apply() { throw new Error("Provider credential commands are outside this proof."); },
  };
  const runtime = new cli.DefaultProviderRuntime(
    openRouter,
    credentialStore,
    registry,
    stateStore,
    orchestrator,
    activationCoordinator,
    runtimeGuard,
    providerCredentials,
    null,
    null,
    persisted.mainModel,
    persisted,
    session,
    undefined,
    "local-interactive-owner",
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    counters.network += 1;
    throw new Error("Network is forbidden in the provider CLI PTY proof.");
  };

  let inputAttempt = 0;
  let hubAttempt = 0;
  let secretAttempt = 0;
  let modelAttempt = 0;
  let confirmAttempt = 0;
  const emitStage = (stage, attempt) => {
    process.stdout.write(`\nORCODE_CLI_STAGE:${JSON.stringify({ stage, attempt })}\n`);
  };
  const originalReadInput = tui.TerminalUi.prototype.readInput;
  tui.TerminalUi.prototype.readInput = function (...args) {
    const pending = originalReadInput.apply(this, args);
    emitStage("input", ++inputAttempt);
    return Promise.resolve(pending).then((value) => {
      if (typeof value === "string") commands.push(value);
      return value;
    });
  };
  const originalPickChoice = tui.TerminalUi.prototype.pickChoice;
  tui.TerminalUi.prototype.pickChoice = function (title, ...args) {
    const pending = originalPickChoice.call(this, title, ...args);
    if (title !== "Provider setup") return pending;
    emitStage("hub", ++hubAttempt);
    return Promise.resolve(pending).then((value) => {
      providerSelections.push(value?.value ?? null);
      return value;
    });
  };
  const originalReadSecret = tui.TerminalUi.prototype.readSecret;
  tui.TerminalUi.prototype.readSecret = function (...args) {
    const pending = originalReadSecret.apply(this, args);
    emitStage("secret", ++secretAttempt);
    return Promise.resolve(pending).then((value) => {
      secretEntries.push({ supplied: value !== null, length: value?.length ?? 0 });
      return value;
    });
  };
  const originalPickModel = tui.TerminalUi.prototype.pickModel;
  tui.TerminalUi.prototype.pickModel = function (search, currentModel, title, ...args) {
    const catalog = search("").map((model) => model.id);
    const pending = originalPickModel.call(this, search, currentModel, title, ...args);
    if (title !== "Choose a model") return pending;
    modelCatalogs.push(catalog);
    emitStage("model", ++modelAttempt);
    return Promise.resolve(pending).then((value) => {
      modelSelections.push(value?.id ?? null);
      return value;
    });
  };
  const originalConfirmAction = tui.TerminalUi.prototype.confirmAction;
  tui.TerminalUi.prototype.confirmAction = function (...args) {
    const pending = originalConfirmAction.apply(this, args);
    emitStage("confirm", ++confirmAttempt);
    return Promise.resolve(pending).then((value) => {
      confirmations.push(value.accepted);
      return value;
    });
  };

  const setupSnapshots = [];
  const originalExecute = runtime.execute.bind(runtime);
  runtime.execute = async (intent, surface) => {
    providerIntents.push(structuredClone(intent));
    const before = semanticSnapshot();
    const result = await originalExecute(intent, surface);
    if (intent.kind === "setup") setupSnapshots.push({ before, after: semanticSnapshot(), outcome: result.outcome });
    process.stdout.write(`\nORCODE_CLI_EXECUTE:${JSON.stringify({ intent, kind: result.kind, outcome: result.outcome ?? null })}\n`);
    return result;
  };

  process.stdout.write(`ORCODE_CLI_READY:${JSON.stringify({
    cliModule: "dist/cli.js",
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
  })}\n`);
  process.chdir(workspace);
  let exitCode = null;
  try {
    exitCode = await cli.runCli([], {
      initializeStorage: async () => ({
        appHome,
        configPath,
        migrationWarning: null,
        retentionWarnings: [],
        config: persisted,
        ruleStore: rules,
        session,
      }),
      createProviderRuntime: async () => runtime,
      createAgent: async () => {
        counters.agent += 1;
        throw new Error("No agent run belongs in the provider setup proof.");
      },
      runPlain: cli.runPlainLoop,
      runDashboard: async (input) => cli.runDashboard(input),
      stdout: process.stdout,
      stderr: process.stderr,
      environment: { ...process.env, OPENROUTER_API_KEY: undefined, FORCE_COLOR: undefined },
    });
  } finally {
    globalThis.fetch = originalFetch;
    const state = stateStore.read();
    const configOnDisk = await configModule.loadConfig(configPath);
    const finalCredential = credentialSlots.get(CREDENTIAL_SLOT);
    process.stdout.write(`\nORCODE_CLI_RESULT:${JSON.stringify({
      exitCode,
      commands,
      providerIntents,
      providerSelections,
      modelCatalogs,
      modelSelections,
      secretEntries,
      confirmations,
      setupSnapshots,
      counters,
      state: {
        lifecycle: state.lifecycle,
        revision: state.revision,
        connectionCount: state.connections.length,
        accountFingerprint: state.connections[0]?.accountFingerprint ?? null,
        defaultRoute: state.defaultRoute,
      },
      configMainModel: persisted.mainModel,
      configDiskMainModel: configOnDisk.mainModel,
      sessionRoute: session.data.route ?? null,
      credentialStored: finalCredential === syntheticCredential(),
      credentialSlotCount: credentialSlots.size,
    })}\n`);
    await rm(root, { recursive: true, force: true });
  }
  process.exitCode = exitCode ?? 1;
}

function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return pathToFileURL(resolve(entry)).href === import.meta.url; } catch { return false; }
}

if (isEntrypoint() && process.argv[2] === "child") {
  await runChildHarness();
}
