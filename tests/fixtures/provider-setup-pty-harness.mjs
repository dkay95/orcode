#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 384 * 1024;
const MAX_HOME_AUDIT_BYTES = 1024 * 1024;
const MAX_HOME_AUDIT_FILES = 100;

const CLEAN_CREDENTIAL_PARTS = Object.freeze([
  "sk-or-v1-",
  "task-ten-alpha-",
  "task-ten-beta-",
  "task-ten-gamma-",
  "task-ten-delta-0001",
]);

export function syntheticProviderCredential() {
  return CLEAN_CREDENTIAL_PARTS.join("");
}

export function syntheticProviderCredentialFragments() {
  const candidate = syntheticProviderCredential();
  return Object.freeze([
    candidate.slice(0, 24),
    candidate.slice(-24),
    candidate.slice(10, 34),
  ]);
}

export function syntheticInvalidProviderCredentials() {
  const candidate = syntheticProviderCredential();
  return Object.freeze({
    "reject-nul": Buffer.from(`${candidate.slice(0, 24)}\0${candidate.slice(24)}`).toString("base64"),
    "reject-ansi": Buffer.from(`${candidate.slice(0, 24)}\u001b[31m${candidate.slice(24)}`).toString("base64"),
    "reject-control": Buffer.from(`${candidate.slice(0, 24)}\u0007${candidate.slice(24)}`).toString("base64"),
    "retry-clean": Buffer.from(`${candidate.slice(0, 20)}\0${candidate.slice(20)}`).toString("base64"),
  });
}

export async function buildFreshProviderSetupModules(projectRoot) {
  const buildRoot = await mkdtemp(join(projectRoot, ".orcode-provider-proof-"));
  const outputRoot = join(buildRoot, "dist");
  const tsc = join(projectRoot, "node_modules", "typescript", "bin", "tsc");
  const build = await execFilePromise(
    process.execPath,
    [
      tsc,
      "-p",
      join(projectRoot, "tsconfig.json"),
      "--outDir",
      outputRoot,
      "--declaration",
      "false",
      "--sourceMap",
      "false",
    ],
    {
      cwd: projectRoot,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (build.failed) {
    throw new Error("The isolated provider proof build failed.");
  }
  return {
    buildRoot,
    moduleRoot: relative(projectRoot, outputRoot),
    async cleanup() {
      await rm(buildRoot, { recursive: true, force: true });
    },
  };
}

const PYTHON_CONTROLLER = String.raw`
import base64
import errno
import fcntl
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
os.setsid()
master = -1
slave = -1
process = None
captured = bytearray()
deadline = time.monotonic() + (config["timeoutMs"] / 1000.0)

clean = (
    b"sk-or-v1-"
    + b"task-ten-alpha-"
    + b"task-ten-beta-"
    + b"task-ten-gamma-"
    + b"task-ten-delta-0001"
)

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

def wait_for_growth(previous_size):
    while len(captured) <= previous_size:
        if time.monotonic() >= deadline:
            raise TimeoutError("render-timeout")
        if process.poll() is not None and not read_once(0.0):
            raise RuntimeError("early-exit")
        read_once(0.05)

def write_all(data):
    offset = 0
    while offset < len(data):
        offset += os.write(master, data[offset:])

def stage(name, attempt):
    return ('ORCODE_PROVIDER_STAGE:{"stage":"' + name + '","attempt":' + str(attempt) + '}').encode("ascii")

def paste(value):
    write_all(b"\x1b[200~" + value + b"\x1b[201~")

def complete_valid_secret(check_before_enter):
    wait_for(stage("secret", 1))
    before = len(captured)
    paste(b"\xc2\xa0" + clean + b"\r\n\xe3\x80\x80")
    wait_for_growth(before)
    if check_before_enter:
        os.kill(process.pid, signal.SIGUSR1)
        wait_for(b"ORCODE_PROVIDER_CHECKPOINT:")
    write_all(b"\r")

def finish_valid_flow(cross_key=b"\r"):
    wait_for(stage("model", 1))
    write_all(b"\r")
    wait_for(stage("confirm", 1))
    write_all(b"y")
    wait_for(stage("cross", 1))
    write_all(cross_key)

try:
    master, slave = os.openpty()
    size = struct.pack("HHHH", config["rows"], config["columns"], 0, 0)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
    child_env = {
        "HOME": os.environ["HOME"],
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "ORCODE_ASCII": "1",
        "ORCODE_PROVIDER_MODULE_ROOT": config["moduleRoot"],
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "TERM": "xterm-256color",
    }
    process = subprocess.Popen(
        [config["nodeExecutable"], config["harnessPath"], config["scenario"]],
        cwd=os.getcwd(),
        env=child_env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        start_new_session=False,
    )
    sys.stderr.write("ORCODE_PROVIDER_CHILD_STARTED\n")
    sys.stderr.flush()
    os.close(slave)
    slave = -1

    if config["scenario"] == "force-outer-timeout":
        while True:
            time.sleep(1.0)

    wait_for(b"ORCODE_PROVIDER_READY:")
    wait_for(stage("hub", 1))
    write_all(b"\r")
    scenario = config["scenario"]

    if scenario == "success":
        complete_valid_secret(True)
        finish_valid_flow()
    elif scenario == "reject-nul":
        wait_for(stage("secret", 1))
        paste(clean[:24] + b"\x00" + clean[24:])
        write_all(b"\r")
        wait_for(stage("rejected", 1))
        wait_for(stage("hub", 2))
        write_all(b"\x1b")
    elif scenario == "reject-ansi":
        wait_for(stage("secret", 1))
        paste(clean[:24] + b"\x1b[31m" + clean[24:])
        write_all(b"\r")
        wait_for(stage("rejected", 1))
        wait_for(stage("hub", 2))
        write_all(b"\x1b")
    elif scenario == "reject-control":
        wait_for(stage("secret", 1))
        paste(clean[:24] + b"\x07" + clean[24:])
        write_all(b"\r")
        wait_for(stage("rejected", 1))
        wait_for(stage("hub", 2))
        write_all(b"\x1b")
    elif scenario == "retry-clean":
        wait_for(stage("secret", 1))
        paste(clean[:20] + b"\x00" + clean[20:])
        write_all(b"\r")
        wait_for(stage("rejected", 1))
        wait_for(stage("hub", 2))
        write_all(b"\r")
        wait_for(stage("secret", 2))
        paste(clean)
        write_all(b"\r")
        wait_for(stage("model", 1))
        write_all(b"\r")
        wait_for(stage("confirm", 1))
        write_all(b"y")
        wait_for(stage("cross", 1))
        write_all(b"\r")
    elif scenario == "escape-secret":
        wait_for(stage("secret", 1))
        write_all(b"\x1b")
        wait_for(stage("chat", 1))
        write_all(b"weiter im chat\r")
    elif scenario == "escape-model":
        complete_valid_secret(False)
        wait_for(stage("model", 1))
        write_all(b"\x1b")
        wait_for(stage("chat", 1))
        write_all(b"weiter im chat\r")
    elif scenario == "escape-cross":
        complete_valid_secret(False)
        finish_valid_flow(b"\x1b")
    else:
        raise RuntimeError("unknown-scenario")

    while process.poll() is None:
        if time.monotonic() >= deadline:
            raise TimeoutError("process-timeout")
        read_once(0.05)
    while read_once(0.0):
        pass

    result = {
        "exitCode": process.returncode,
        "outputBase64": base64.b64encode(bytes(captured)).decode("ascii"),
        "timedOut": False,
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
except Exception:
    failure = {
        "controllerError": "provider-pty-controller-failed",
        "outputBase64": base64.b64encode(bytes(captured)).decode("ascii"),
    }
    sys.stdout.write(json.dumps(failure, separators=(",", ":")))
    sys.exit(1)
finally:
    if slave >= 0:
        os.close(slave)
    if process is not None and process.poll() is None:
        try:
            process.terminate()
            process.wait(timeout=0.5)
        except Exception:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            process.wait(timeout=0.5)
    if master >= 0:
        os.close(master)
`;

export async function runProviderSetupPtyScenario(options) {
  if (process.platform === "win32") {
    throw new Error("The real POSIX provider PTY proof does not cover ConPTY.");
  }
  const request = {
    columns: options.columns ?? DEFAULT_COLUMNS,
    harnessPath: relative(options.projectRoot, fileURLToPath(import.meta.url)),
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    moduleRoot: options.moduleRoot,
    nodeExecutable: process.execPath,
    rows: options.rows ?? DEFAULT_ROWS,
    scenario: options.scenario,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const python = options.pythonExecutable ?? "/usr/bin/python3";
  const isolatedHome = await mkdtemp(join(tmpdir(), "orcode-provider-pty-home-"));
  let execution;
  let homeAudit;
  try {
    execution = await execFilePromise(
      python,
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
        timeout: options.controllerTimeoutMs ?? request.timeoutMs + 2_000,
        killProcessGroupOnFailure: true,
      },
    );
  } finally {
    try {
      homeAudit = await auditIsolatedProviderHome(
        isolatedHome,
        options.projectRoot,
        options.moduleRoot,
      );
    } catch {
      homeAudit = failedHomeAudit();
    } finally {
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }
  if (homeAudit.auditFailed || homeAudit.privacyFindings > 0) {
    throw await safePtyFailure(
      Buffer.alloc(0),
      "provider-pty-home-privacy-failed",
      options.projectRoot,
      options.moduleRoot,
      {
        homeAudit,
        childStarted: execution.stderr.includes("ORCODE_PROVIDER_CHILD_STARTED"),
        processGroupAliveAfterCleanup: execution.processGroupAliveAfterCleanup,
      },
    );
  }
  let controller;
  try {
    controller = JSON.parse(execution.stdout.trim());
  } catch {
    throw await safePtyFailure(
      Buffer.from(execution.stdout),
      execution.failed
        ? "provider-pty-controller-failed"
        : "provider-pty-controller-invalid",
      options.projectRoot,
      options.moduleRoot,
      {
        childStarted: execution.stderr.includes("ORCODE_PROVIDER_CHILD_STARTED"),
        homeAudit,
        processGroupAliveAfterCleanup: execution.processGroupAliveAfterCleanup,
      },
    );
  }
  if (
    execution.failed
    || controller.controllerError
    || controller.timedOut
    || controller.exitCode !== 0
  ) {
    const failureBytes = typeof controller.outputBase64 === "string"
      ? Buffer.from(controller.outputBase64, "base64")
      : Buffer.alloc(0);
    throw await safePtyFailure(
      failureBytes,
      "provider-pty-controller-failed",
      options.projectRoot,
      options.moduleRoot,
      {
        childStarted: execution.stderr.includes("ORCODE_PROVIDER_CHILD_STARTED"),
        homeAudit,
        processGroupAliveAfterCleanup: execution.processGroupAliveAfterCleanup,
      },
    );
  }
  const outputBytes = Buffer.from(controller.outputBase64, "base64");
  if (outputBytes.length === 0 || outputBytes.length > request.maxOutputBytes) {
    throw new Error("The provider PTY transcript is empty or exceeded its cap.");
  }
  const output = outputBytes.toString("utf8");
  const ready = lastJsonMarker(output, "ORCODE_PROVIDER_READY:");
  const result = lastJsonMarker(output, "ORCODE_PROVIDER_RESULT:");
  const checkpoints = jsonMarkers(output, "ORCODE_PROVIDER_CHECKPOINT:");
  return {
    checkpoints,
    homeAudit,
    output,
    outputBase64: controller.outputBase64,
    ready,
    result,
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
    try {
      values.push(JSON.parse(line));
    } catch {
      // A later complete marker is still authoritative; partial redraw bytes
      // cannot turn into a successful proof.
    }
    offset = valueStart;
  }
  return values;
}

function lastJsonMarker(output, marker) {
  const values = jsonMarkers(output, marker);
  if (!values.length) throw new Error(`Provider PTY output omitted ${marker}`);
  return values.at(-1);
}

function execFilePromise(file, args, options) {
  const {
    killProcessGroupOnFailure = false,
    ...execOptions
  } = options;
  return new Promise((resolvePromise) => {
    let childPid;
    const child = execFile(file, args, execOptions, async (error, stdout, stderr) => {
      let processGroupAliveAfterCleanup = false;
      if (error !== null && killProcessGroupOnFailure && childPid) {
        processGroupAliveAfterCleanup = await terminateProcessGroup(childPid);
      }
      resolvePromise({
        failed: error !== null,
        processGroupAliveAfterCleanup,
        stderr,
        stdout,
      });
    });
    childPid = child.pid;
  });
}

async function terminateProcessGroup(processGroupId) {
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  if (!processGroupAlive(processGroupId)) return false;
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  return processGroupAlive(processGroupId);
}

function processGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function auditIsolatedProviderHome(homeRoot, projectRoot, moduleRoot) {
  const redaction = await import(
    pathToFileURL(join(resolve(projectRoot, moduleRoot), "redaction.js")).href
  );
  const artifacts = [];
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        artifacts.push({ path, relativePath: relative(homeRoot, path).replaceAll("\\", "/") });
      } else {
        throw new Error("Provider PTY home contains a non-regular artifact.");
      }
    }
  }
  await visit(homeRoot);
  if (artifacts.length > MAX_HOME_AUDIT_FILES) {
    throw new Error("Provider PTY home exceeded its file audit cap.");
  }

  const digest = createHash("sha256");
  const exactBuffers = [
    syntheticProviderCredential(),
    ...syntheticProviderCredentialFragments(),
  ].map((value) => Buffer.from(value));
  exactBuffers.push(
    ...Object.values(syntheticInvalidProviderCredentials())
      .map((encoded) => Buffer.from(encoded, "base64")),
  );
  let privacyFindings = 0;
  let totalBytes = 0;
  for (const artifact of artifacts) {
    const facts = await stat(artifact.path);
    totalBytes += facts.size;
    if (totalBytes > MAX_HOME_AUDIT_BYTES) {
      throw new Error("Provider PTY home exceeded its byte audit cap.");
    }
    const bytes = await readFile(artifact.path);
    const textValue = bytes.toString("utf8");
    const pathBytes = Buffer.from(artifact.relativePath);
    digest.update(`${artifact.relativePath}\0${bytes.length}\0`);
    digest.update(bytes);
    privacyFindings += redaction.scanForSecrets(textValue).length;
    privacyFindings += redaction.scanForSecrets(artifact.relativePath).length;
    privacyFindings += exactBuffers.filter((probe) => bytes.includes(probe)).length;
    privacyFindings += exactBuffers.filter((probe) => pathBytes.includes(probe)).length;
    if (containsPrivateHome(`${artifact.relativePath}\n${textValue}`)) privacyFindings += 1;
  }
  return {
    auditFailed: false,
    fileCount: artifacts.length,
    privacyFindings,
    sha256: digest.digest("hex"),
    totalBytes,
  };
}

function failedHomeAudit() {
  return {
    auditFailed: true,
    fileCount: 0,
    privacyFindings: 1,
    sha256: createHash("sha256").digest("hex"),
    totalBytes: 0,
  };
}

function containsPrivateHome(value) {
  const usersDirectory = ["Us", "ers"].join("");
  const homeDirectory = ["ho", "me"].join("");
  const rootDirectory = ["ro", "ot"].join("");
  return [
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:file:\\/\\/)?\\/${usersDirectory}\\/[^/\\s]+(?:\\/|\\b)`, "i"),
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:file:\\/\\/)?\\/${homeDirectory}\\/[^/\\s]+(?:\\/|\\b)`, "i"),
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:file:\\/\\/)?\\/${rootDirectory}(?:\\/|\\b)`, "i"),
    new RegExp(`(?:^|[^A-Za-z0-9_])(?:file:\\/\\/\\/)?[A-Za-z]:[\\\\/]${usersDirectory}[\\\\/][^\\\\/\\s]+(?:[\\\\/]|\\b)`, "i"),
  ].some((pattern) => pattern.test(value));
}

async function safePtyFailure(
  outputBytes,
  code,
  projectRoot,
  moduleRoot,
  cleanup = {},
) {
  const output = outputBytes.toString("utf8");
  let findings = 0;
  if (projectRoot && moduleRoot) {
    try {
      const redaction = await import(
        pathToFileURL(join(resolve(projectRoot, moduleRoot), "redaction.js")).href
      );
      findings += redaction.scanForSecrets(output).length;
    } catch {
      findings += 1;
    }
  }
  const exactProbes = [
    syntheticProviderCredential(),
    ...syntheticProviderCredentialFragments(),
  ];
  findings += exactProbes.filter((probe) => output.includes(probe)).length;
  const invalidProbes = Object.values(syntheticInvalidProviderCredentials())
    .map((encoded) => Buffer.from(encoded, "base64"));
  findings += invalidProbes.filter((probe) => outputBytes.includes(probe)).length;
  const error = new Error("The bounded provider POSIX PTY scenario failed.");
  error.code = code;
  error.outputBytes = outputBytes.length;
  error.outputSha256 = createHash("sha256").update(outputBytes).digest("hex");
  error.privacyFindings = findings;
  error.childStarted = cleanup.childStarted === true;
  error.homeAuditFailed = cleanup.homeAudit?.auditFailed === true;
  error.homeFileCount = cleanup.homeAudit?.fileCount ?? 0;
  error.homePrivacyFindings = cleanup.homeAudit?.privacyFindings ?? 0;
  error.homeSha256 = cleanup.homeAudit?.sha256
    ?? createHash("sha256").digest("hex");
  error.homeTotalBytes = cleanup.homeAudit?.totalBytes ?? 0;
  error.processGroupAliveAfterCleanup = cleanup.processGroupAliveAfterCleanup === true;
  return error;
}

async function runChildHarness(scenario) {
  const moduleRoot = process.env.ORCODE_PROVIDER_MODULE_ROOT;
  if (!moduleRoot) throw new Error("Provider proof module root is unavailable.");
  const absoluteModuleRoot = resolve(process.cwd(), moduleRoot);
  const counters = {
    activation: 0,
    adapter: 0,
    config: 0,
    credentialStore: 0,
    discard: 0,
    modelCatalog: 0,
    network: 0,
    state: 0,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    counters.network += 1;
    throw new Error("Network is forbidden in the provider PTY proof.");
  };
  const [{ TerminalUi }, setupUi, backends, providerState] = await Promise.all([
    import(pathToFileURL(join(absoluteModuleRoot, "tui.js")).href),
    import(pathToFileURL(join(absoluteModuleRoot, "setup-ui.js")).href),
    import(pathToFileURL(join(absoluteModuleRoot, "backends.js")).href),
    import(pathToFileURL(join(absoluteModuleRoot, "provider-state.js")).href),
  ]);

  const observed = [];
  const stateStore = new providerState.ProviderStateStore(
    providerState.createNeverConfiguredProviderState(),
  );
  const route = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_or_task_ten_safe",
    billingRealm: "openrouter-payg",
    requestedModelId: "synthetic/task-ten-requested",
    canonicalModelId: "synthetic/task-ten-canonical",
    resolutionState: "resolved",
  };
  const model = {
    backendId: "openrouter",
    requestedModelId: route.requestedModelId,
    canonicalModelId: route.canonicalModelId,
    displayName: "Task Ten Local Model",
    capabilities: {
      textInput: true,
      textOutput: true,
      tools: true,
      reasoning: true,
    },
  };
  let candidateCounter = 0;
  const adapter = {
    backendId: "openrouter",
    async inspect() {
      counters.adapter += 1;
      throw new Error("Inspection is outside the provider PTY proof.");
    },
    async connect(request) {
      counters.adapter += 1;
      observed.push(request.candidate);
      const candidateId = `candidate-${++candidateCounter}`;
      return {
        candidateId,
        backendId: "openrouter",
        connectionId: "task-ten-connection",
        accountFingerprint: route.accountFingerprint,
        billingRealm: route.billingRealm,
        health: {
          credential: "valid",
          connectivity: "connected",
          spend: "unknown",
          runtime: "not-applicable",
          observedAt: 10,
          generation: request.generation,
        },
      };
    },
    async listModels() {
      counters.modelCatalog += 1;
      return [model];
    },
    async activate() {
      counters.adapter += 1;
      throw new Error("The fake coordinator owns activation.");
    },
    async reconnect() {
      counters.adapter += 1;
      throw new Error("Reconnect is outside the provider PTY proof.");
    },
    async logout() {
      counters.adapter += 1;
      throw new Error("Logout is outside the provider PTY proof.");
    },
    async discardCandidate() {
      counters.discard += 1;
    },
  };
  const registry = new backends.BackendRegistry([
    {
      descriptor: {
        id: "openrouter",
        displayName: "OpenRouter",
        maturity: "stable",
        connectable: true,
        kind: "raw-model",
        credentialOwner: "orcode-keychain",
        billingRealmKind: "api-payg",
        capabilities: { models: true, tools: true, reasoning: true },
      },
      adapter,
    },
    {
      descriptor: {
        id: "anthropic",
        displayName: "Anthropic",
        maturity: "coming-soon",
        connectable: false,
        kind: "managed-agent",
        credentialOwner: "none",
        billingRealmKind: "none",
        capabilities: { models: false, tools: false, reasoning: false },
      },
    },
  ]);
  const orchestrator = {
    async activateCandidate(request) {
      counters.activation += 1;
      counters.credentialStore += 1;
      counters.config += 1;
      counters.state += 1;
      const committed = await stateStore.commit(stateStore.read().revision, (current) => ({
        ...current,
        lifecycle: "configured",
        connections: [{
          id: "task-ten-connection",
          backendId: "openrouter",
          enabled: true,
          maturity: "stable",
          credentialSlot: "provider-slot:v1:inference:10000000-0000-4000-8000-000000000010",
          accountFingerprint: route.accountFingerprint,
          accountFingerprintState: "verified",
          billingRealm: "openrouter-payg",
          lastHealth: null,
        }],
        defaultRoute: route,
        cross: { enabled: false, preferredLead: null, preferredChallenger: null },
      }));
      return { persisted: true, route, state: committed, warnings: [] };
    },
  };
  const terminalState = {
    workspace: "provider-proof-workspace",
    projectStatus: "provider proof",
    model: route.requestedModelId,
    modelDetails: "local fake only",
    approval: "ask",
    compressor: "auto",
    compressorModel: "synthetic/compressor",
    reasoning: "auto",
    balance: "not requested",
    sessionCost: "$0.000",
    maxCost: "$1.000",
    maxSteps: 1,
    keyStatus: "setup",
  };
  const ready = {
    homeIsolated: homedir() === process.env.HOME
      && process.env.HOME.includes("orcode-provider-pty-home-"),
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
  };
  process.stdout.write(`ORCODE_PROVIDER_READY:${JSON.stringify(ready)}\n`);
  const ui = new TerminalUi(() => terminalState, process.stdin, process.stdout);
  let hubAttempt = 0;
  let secretAttempt = 0;
  let modelAttempt = 0;
  let confirmAttempt = 0;
  let crossAttempt = 0;
  let rejectedAttempt = 0;
  const emitStage = (stage, attempt) => {
    process.stdout.write(`\nORCODE_PROVIDER_STAGE:${JSON.stringify({ stage, attempt })}\n`);
  };
  const baseSurface = setupUi.createTuiSetupSurface(ui);
  const surface = {
    async chooseHub(entries) {
      const cross = entries.some((entry) => entry.id === "cross-later");
      const pending = baseSurface.chooseHub(entries);
      if (cross) emitStage("cross", ++crossAttempt);
      else {
        hubAttempt += 1;
        if (hubAttempt > 1) emitStage("rejected", ++rejectedAttempt);
        emitStage("hub", hubAttempt);
      }
      return pending;
    },
    readSecret(request) {
      const pending = baseSurface.readSecret(request);
      emitStage("secret", ++secretAttempt);
      return pending;
    },
    chooseModel(request) {
      const pending = baseSurface.chooseModel(request);
      emitStage("model", ++modelAttempt);
      return pending;
    },
    confirm(request) {
      const pending = baseSurface.confirm(request);
      emitStage("confirm", ++confirmAttempt);
      return pending;
    },
    present(event) {
      baseSurface.present(event);
    },
  };

  const checkpoint = () => {
    process.stdout.write(`\nORCODE_PROVIDER_CHECKPOINT:${JSON.stringify({
      activation: counters.activation,
      adapter: counters.adapter,
      config: counters.config,
      credentialStore: counters.credentialStore,
      state: counters.state,
    })}\n`);
  };
  process.on("SIGUSR1", checkpoint);
  let setupResult = null;
  let chatAccepted = false;
  let failure = false;
  try {
    if (!ui.supported) throw new Error("Real TTY pair required.");
    ui.start();
    setupResult = await setupUi.runSetupHub({
      surface,
      orchestrator,
      registry,
      stateStore,
    });
    if (setupResult.kind === "cancelled" && scenario.startsWith("escape-")) {
      const chat = ui.readInput();
      emitStage("chat", 1);
      chatAccepted = (await chat) === "weiter im chat";
    }
  } catch {
    failure = true;
  } finally {
    process.off("SIGUSR1", checkpoint);
    ui.stop();
    globalThis.fetch = originalFetch;
  }
  const current = stateStore.read();
  process.stdout.write(`\nORCODE_PROVIDER_RESULT:${JSON.stringify({
    chatAccepted,
    counters,
    crossEnabled: current.cross.enabled,
    failure,
    observedCandidateCount: observed.length,
    observedCleanOnly: observed.length === 1 && observed[0] === syntheticProviderCredential(),
    routeReady: current.defaultRoute?.resolutionState === "resolved",
    setupKind: setupResult?.kind ?? "failed",
    setupMode: setupResult?.kind === "cancelled" ? setupResult.mode : null,
  })}\n`);
  if (failure) process.exitCode = 1;
}

function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  await runChildHarness(process.argv[2] ?? "");
}
