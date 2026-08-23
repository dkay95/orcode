/**
 * Connection management for `ssh_command`, over the system's own `ssh`
 * client — never a bare-metal reimplementation of the protocol.
 *
 * No passwords anywhere in this file: authentication is `ssh`'s own
 * key/agent handling, forced into `BatchMode=yes` so a missing key fails
 * fast with a clear error instead of hanging on a password prompt nobody can
 * answer.
 *
 * Every function that shells out takes the process runner (`RunSsh`) as an
 * explicit parameter instead of importing one — that keeps this module fully
 * decoupled from `workspace.ts` (no import cycle: `workspace.ts` imports
 * *from* here, wiring in its own `runProcess` for the real runner) and makes
 * the `ssh` invocation trivially injectable in tests, which must never spawn
 * a real `ssh` process or touch the real `~/.orcode`.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSecureDirectory } from "./config.js";
import { findSshHost, type SshHost } from "./ssh-config.js";
import type { ApprovalSubject } from "./types.js";
import { errorMessage } from "./utils.js";
import type { ProcessResult, RunProcessOptions } from "./workspace.js";

export function sshApprovalSubject(
  host: string,
  command: string,
): Extract<ApprovalSubject, { kind: "ssh-command" }> {
  return { kind: "ssh-command", host, command };
}

/** Runs `ssh` with the given arguments. `workspace.ts` supplies the real implementation via `runProcess`; tests supply a fake. */
export type RunSsh = (
  args: string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

export const SSH_APP_HOME = join(homedir(), ".orcode");

export function sshSocketDir(appHome: string = SSH_APP_HOME): string {
  return join(appHome, "ssh");
}

/**
 * Deterministic, short `ControlPath` socket path. The Unix socket path limit
 * is ~104 bytes on macOS (108 on Linux); an alias can be arbitrarily long, so
 * the path is built from a hash of the alias instead of the alias itself —
 * its length never depends on the alias's length. See `ssh.test.ts`.
 */
export function sshSocketPath(alias: string, appHome: string = SSH_APP_HOME): string {
  const hash = createHash("sha256").update(alias).digest("hex").slice(0, 16);
  return join(sshSocketDir(appHome), `${hash}.sock`);
}

export async function ensureSshSocketDir(appHome: string = SSH_APP_HOME): Promise<void> {
  await ensureSecureDirectory(sshSocketDir(appHome));
}

export const DEFAULT_CONTROL_PERSIST = "10m";
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 8;
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;

export interface SshRuntimeOptions {
  /** Root the `ssh/` socket directory lives under. Defaults to `~/.orcode`. */
  appHome?: string;
  /** `ControlPersist` duration, e.g. `"10m"`. */
  controlPersist?: string;
  /** `ConnectTimeout` in seconds for the initial handshake. */
  connectTimeoutSeconds?: number;
}

/**
 * The options every `ssh` invocation in this module shares: no password
 * prompts (`BatchMode=yes`), and a reusable multiplexed connection
 * (`ControlMaster`/`ControlPath`/`ControlPersist`) so a second command to the
 * same host skips the handshake.
 */
function sharedArgs(alias: string, options: SshRuntimeOptions): string[] {
  const socket = sshSocketPath(alias, options.appHome ?? SSH_APP_HOME);
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS}`,
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${socket}`,
    "-o",
    `ControlPersist=${options.controlPersist ?? DEFAULT_CONTROL_PERSIST}`,
  ];
}

export type SshCheckStatus = "reachable" | "no-auth" | "unreachable" | "unknown-host";

export interface SshCheckResult {
  status: SshCheckStatus;
  message: string;
}

/** German instructions for the one-time key setup — never run automatically, because it is the user typing their password. */
export function noAuthMessage(alias: string): string {
  return (
    `Für „${alias}“ ist keine Schlüssel-Authentifizierung hinterlegt. ` +
    `Richte sie einmalig ein mit: ssh-copy-id ${alias}\n` +
    `Danach fragt orcode nie wieder nach Zugangsdaten für diesen Host.`
  );
}

const AUTH_FAILURE_PATTERN = /permission denied|publickey|no supported authentication/i;
const UNREACHABLE_PATTERN =
  /timed out|no route to host|connection refused|could not resolve hostname|network is unreachable/i;

/** Classifies a failed `ssh` invocation from its exit status and stderr — shared by `checkHost` and `ssh_command`'s own failure handling. */
export function classifySshFailure(result: {
  code: number | null;
  stderr: string;
  timedOut?: boolean;
}): "no-auth" | "unreachable" {
  if (AUTH_FAILURE_PATTERN.test(result.stderr)) {
    return "no-auth";
  }
  return "unreachable";
}

function unreachableMessage(alias: string, result: ProcessResult): string {
  const detail = result.launchError || result.stderr.trim() ||
    (result.code === null ? "ssh konnte nicht gestartet werden." : `ssh endete mit Code ${result.code}.`);
  return `„${alias}“ ist gerade nicht erreichbar: ${detail}`;
}

/**
 * One combined reachability + key-auth probe (`ssh … <alias> exit`), with a
 * short timeout. Never asks for a password (`BatchMode=yes`): a missing key
 * surfaces as `"no-auth"` instead of hanging.
 */
export async function checkHost(
  alias: string,
  hosts: readonly SshHost[],
  runSsh: RunSsh,
  options: SshRuntimeOptions = {},
): Promise<SshCheckResult> {
  const host = findSshHost(alias, hosts);
  if (!host) {
    return {
      status: "unknown-host",
      message: `„${alias}“ ist kein bekannter Host aus der SSH-Konfiguration (~/.ssh/config).`,
    };
  }
  const appHome = options.appHome ?? SSH_APP_HOME;
  await ensureSshSocketDir(appHome);
  const connectTimeoutSeconds = options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  const args = [...sharedArgs(alias, options), alias, "exit"];
  const result = await runSsh(args, {
    cwd: appHome,
    timeoutMs: (connectTimeoutSeconds + 5) * 1_000,
  });
  if (result.code === 0) {
    return {
      status: "reachable",
      message: `„${alias}“ ist erreichbar, Schlüssel-Authentifizierung funktioniert.`,
    };
  }
  if (classifySshFailure(result) === "no-auth") {
    return { status: "no-auth", message: noAuthMessage(alias) };
  }
  return { status: "unreachable", message: unreachableMessage(alias, result) };
}

export interface SshExecOptions {
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onChunk?: (stream: "stdout" | "stderr", text: string) => void;
  runtime?: SshRuntimeOptions;
}

export interface SshExecResult {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * Thrown instead of returning a raw failed result when the failure is a
 * missing key, not a remote command error — the caller (the `ssh_command`
 * tool) turns this into a clear, actionable error for the model/user rather
 * than cryptic `ssh` stderr, and the remote command itself never ran: `ssh`
 * fails during authentication, before a shell on the far end ever starts.
 */
export class SshAuthError extends Error {
  readonly alias: string;

  constructor(alias: string) {
    super(noAuthMessage(alias));
    this.name = "SshAuthError";
    this.alias = alias;
  }
}

/** Runs one command on `alias` over the shared `ControlMaster` connection. Throws `SshAuthError` when the key/agent is not set up; throws a plain `Error` for an unknown alias. */
export async function execSshCommand(
  alias: string,
  hosts: readonly SshHost[],
  command: string,
  runSsh: RunSsh,
  options: SshExecOptions = {},
): Promise<SshExecResult> {
  const host = findSshHost(alias, hosts);
  if (!host) {
    throw new Error(`„${alias}“ ist kein bekannter Host aus der SSH-Konfiguration (~/.ssh/config).`);
  }
  const runtime = options.runtime ?? {};
  const appHome = runtime.appHome ?? SSH_APP_HOME;
  await ensureSshSocketDir(appHome);
  const args = [...sharedArgs(alias, runtime), alias, command];
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
  const result = await runSsh(args, {
    cwd: appHome,
    timeoutMs: timeoutSeconds * 1_000,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onChunk ? { onChunk: options.onChunk } : {}),
  });
  if (result.launchError || result.code === null) {
    throw new Error(result.launchError || "ssh konnte nicht gestartet werden.");
  }
  if (result.code !== 0 && classifySshFailure(result) === "no-auth") {
    throw new SshAuthError(alias);
  }
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
  };
}

export interface SshControlCloseReport {
  closed: boolean;
  error?: string;
}

const MISSING_CONTROL_SOCKET = /control socket.*(?:no such file|not found|does not exist)|no master/i;

/** `/ssh off`: tears the `ControlMaster` down (`ssh -O exit`) instead of leaving it to `ControlPersist`'s timeout. A missing socket stays benign; real failures are returned for visible reporting. */
export async function closeSshControl(
  alias: string,
  runSsh: RunSsh,
  options: SshRuntimeOptions = {},
): Promise<SshControlCloseReport> {
  const appHome = options.appHome ?? SSH_APP_HOME;
  const socket = sshSocketPath(alias, appHome);
  try {
    const result = await runSsh(["-o", `ControlPath=${socket}`, "-O", "exit", alias], {
      cwd: appHome,
      timeoutMs: 5_000,
    });
    if (result.code === 0) {
      return { closed: true };
    }
    const detail = result.launchError || result.stderr.trim() ||
      (result.timedOut
        ? "Zeitlimit beim Schließen der SSH-Control-Verbindung."
        : `ssh -O exit endete mit Code ${result.code ?? "unbekannt"}.`);
    return MISSING_CONTROL_SOCKET.test(detail)
      ? { closed: false }
      : { closed: false, error: detail };
  } catch (error) {
    const detail = errorMessage(error);
    return MISSING_CONTROL_SOCKET.test(detail)
      ? { closed: false }
      : { closed: false, error: detail };
  }
}

/** In-memory "which host is `ssh_command`'s remembered target" — set by `/ssh <alias>`, read by the TUI header and cleared by `/ssh off`. Never persisted: a stale remembered host surviving a restart would be worse than asking again. */
export interface SshSession {
  active: string | null;
}

export function createSshSession(): SshSession {
  return { active: null };
}
