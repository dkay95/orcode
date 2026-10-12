/**
 * A4 — Verifikationstor.
 *
 * Runs the user-configured verify commands after a run that touched files,
 * so a green checkmark means "a process ran and was green" instead of "the
 * tool did not throw". Deliberately narrow:
 *
 * - Executes commands directly, the same way `run_command` does (via the
 *   shell resolved by `resolveCommandShell`) — never through the coding
 *   tools, never through `ApprovalManager.authorize`.
 * - Never writes a `PermissionRule`. A verification gate that grants itself
 *   standing permission would contradict the safety promise `rules.ts`
 *   makes elsewhere (K6): a remembered rule always comes from a human
 *   answering a real prompt.
 * - Owns its own event shape (`VerifyCommandEvent`) instead of piggy-backing
 *   on `AgentRunEvent["verify"]"`, so this module has no dependency on how
 *   `agent.ts` numbers rounds or which conversation state a retry runs in.
 *
 * Deliberately NOT here: orchestration policy. `agent.ts` decides *when* to
 * call `runVerify`, owns the bounded repair-model loop, and produces the one
 * root terminal outcome; this module owns one typed, fail-fast command pass.
 */

import {
  DEFAULT_VERIFY,
  VERIFY_MAX_ROUNDS,
  VERIFY_MODES,
  validateVerify,
  type VerifyConfig,
  type VerifyMode,
} from "./config.js";
import {
  resolveCommandShell,
  resolveExecutablePath,
  runObservedProcess,
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
  type WorkspaceGuard,
} from "./workspace.js";
import type { ProcessCallbacks } from "./types.js";
import { redactText } from "./redaction.js";
import { errorMessage, isRecord, truncate } from "./utils.js";

// ---------------------------------------------------------------------------
// Config data model
//
// `VerifyConfig`/`VERIFY_MODES`/`VERIFY_MAX_ROUNDS`/the default value are
// owned by `config.ts` — that is where `OrcodeConfigWithBudget.verify`
// actually lives and is persisted. This module re-exports them under their
// original names for backward compatibility. `validateVerifyConfig` is an
// alias of the persisted canonical validator so command, load and runtime
// callers can never reinterpret the same object differently.
// ---------------------------------------------------------------------------

export { VERIFY_MAX_ROUNDS, VERIFY_MODES };
export type { VerifyConfig, VerifyMode };
export const DEFAULT_VERIFY_CONFIG: VerifyConfig = DEFAULT_VERIFY;

/**
 * Never throws: an invalid or half-written `verify` field falls back to
 * defaults field-by-field, the same shape `validateConfig`/`validateBudget`
 * use in `config.ts`.
 */
export function validateVerifyConfig(value: unknown): VerifyConfig {
  return validateVerify(value);
}

// ---------------------------------------------------------------------------
// Suggestion — derived from package.json on first setup
// ---------------------------------------------------------------------------

const SUGGESTION_PRIORITY = ["check", "test", "build"] as const;

/**
 * `check` > `test` > `build`: whichever of these scripts exist, offered in
 * that priority order (a project with only `test`+`build` suggests both, in
 * that order — `check` alone suggests only `check`).
 */
export function suggestVerifyCommands(packageJson: unknown): string[] {
  if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
    return [];
  }
  const scripts = packageJson.scripts;
  const suggested: string[] = [];
  for (const name of SUGGESTION_PRIORITY) {
    if (typeof scripts[name] === "string") {
      suggested.push(`npm run ${name}`);
    }
  }
  return suggested;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface VerifyCommandEvent {
  command: string;
  exitCode: number;
  durationMs: number;
  timestamp: number;
}

export type OnVerifyEvent = (event: VerifyCommandEvent) => void;

export type VerifyOutcome =
  | { status: "passed" }
  | { status: "failed"; command: string; exitCode: number; distilled: string }
  | { status: "timed-out"; command: string }
  | { status: "terminated"; command: string; signal: NodeJS.Signals }
  | { status: "spawn-failed"; command: string; error: string }
  | { status: "cancelled" };

const VERIFY_TIMEOUT_MS = 120_000;
const VERIFY_FAILURE_MAX_CHARS = 4_000;
const CMD_NATIVE_COMMANDS = new Set([
  "assoc", "break", "call", "cd", "chdir", "cls", "color", "copy", "date",
  "del", "dir", "echo", "endlocal", "erase", "exit", "for", "ftype", "goto",
  "if", "md", "mkdir", "mklink", "move", "path", "pause", "popd", "prompt",
  "pushd", "rd", "rem", "ren", "rename", "rmdir", "set", "setlocal", "shift",
  "start", "time", "title", "type", "ver", "verify", "vol",
]);
const POWERSHELL_LANGUAGE_KEYWORDS = new Set([
  "begin", "break", "catch", "class", "clean", "configuration", "continue",
  "data", "define", "do", "dynamicparam", "else", "elseif", "end", "enum",
  "exit", "filter", "finally", "for", "foreach", "from", "function", "hidden",
  "if", "in", "inlinescript", "parallel", "param", "process", "return",
  "sequence", "static", "switch", "throw", "trap", "try", "until", "using",
  "var", "while", "workflow",
]);

/** Same pattern the render layer (2.5) uses to pick the informative lines out of red output. */
const FAILURE_LINE_PATTERN = /(^|\s)(error|ERROR|FAIL|✗|panic|Traceback|error TS\d+)/;
const DISTILL_MAX_LINES = 12;

export interface VerifyExecutionOptions {
  /** Injectable child boundary for deterministic timeout/spawn tests. */
  execute?: (
    executable: string,
    args: string[],
    options: RunProcessOptions,
  ) => Promise<ProcessResult>;
  /** Deterministic cross-platform command preflight dependencies for tests. */
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolveExecutable?: typeof resolveExecutablePath;
}

/**
 * Runs `commands` in order against `guard.root`, stopping at the first
 * non-zero exit. Cancellation (`signal`) always wins over a failure: a run
 * the user aborted mid-verify is `"cancelled"`, never `"failed"`.
 *
 * One call is one verification pass over the full command list — the
 * retry-with-model loop across `VerifyConfig.maxRepairRounds` is the caller's
 * responsibility (see the module doc comment).
 *
 * Execution goes through `runProcess` (`workspace.ts`) — the same shell
 * resolution, output bounding, and process-group kill-on-timeout/-abort that
 * `run_command` uses — so this module carries no second process runner.
 */
export async function runVerify(
  commands: string[],
  guard: WorkspaceGuard,
  signal: AbortSignal | undefined,
  onEvent: OnVerifyEvent,
  processCallbacks: ProcessCallbacks = {},
  execution: VerifyExecutionOptions = {},
): Promise<VerifyOutcome> {
  for (const command of commands) {
    if (signal?.aborted) {
      return { status: "cancelled" };
    }
    const start = Date.now();
    let result: ProcessResult;
    try {
      result = await runObservedProcess(
        "verify",
        { command },
        processCallbacks,
        async (onChunk) => {
          const environment = execution.environment ?? process.env;
          const platform = execution.platform ?? process.platform;
          const resolveExecutable = execution.resolveExecutable ?? resolveExecutablePath;
          let shell: Awaited<ReturnType<typeof resolveCommandShell>>;
          try {
            shell = await resolveCommandShell(environment, platform, resolveExecutable);
          } catch (error) {
            return launchFailure(error);
          }
          // Production preflights only an unambiguous top-level simple
          // executable. Ambiguous/compound shell programs are never
          // reclassified from their freely controlled stdout/stderr. Tests
          // with an injected executor own their structured launch fixture.
          const execute = execution.execute ?? runProcess;
          if (!execution.execute || execution.resolveExecutable) {
            try {
              const preflightFailure = await preflightSimpleVerifyCommand(
                command,
                shell.executable,
                shell.args,
                guard.root,
                environment,
                platform,
                resolveExecutable,
                execute,
                signal,
              );
              if (preflightFailure) return preflightFailure;
            } catch (error) {
              return launchFailure(error);
            }
          }
          const executed = await execute(
            shell.executable,
            [...shell.args, command],
            {
              cwd: guard.root,
              timeoutMs: VERIFY_TIMEOUT_MS,
              ...(signal ? { signal } : {}),
              onChunk,
            },
          );
          return executed.launchError
            ? { ...executed, code: null, launchError: compactExecutionError(executed.launchError) }
            : executed;
        },
      );
    } catch (error) {
      if (signal?.aborted) {
        return { status: "cancelled" };
      }
      return {
        status: "spawn-failed",
        command,
        error: compactExecutionError(error),
      };
    }
    // onProcessEnd is synchronous and may be the callback that aborts the
    // root. Recheck only after that terminal observer has returned.
    if (signal?.aborted || result.aborted) {
      return { status: "cancelled" };
    }
    if (result.timedOut) {
      return { status: "timed-out", command };
    }
    if (result.signal) {
      return { status: "terminated", command, signal: result.signal };
    }
    if (result.launchError || result.code === null) {
      return {
        status: "spawn-failed",
        command,
        error: compactExecutionError(
          result.launchError || "The command could not be started.",
        ),
      };
    }
    onEvent({
      command,
      exitCode: result.code,
      durationMs: Date.now() - start,
      timestamp: Date.now(),
    });
    if (result.code !== 0) {
      return {
        status: "failed",
        command,
        exitCode: result.code,
        distilled: distillFailure(result.stdout, result.stderr),
      };
    }
  }
  return { status: "passed" };
}

function compactExecutionError(error: unknown): string {
  return truncate(redactText(errorMessage(error)), 1_000);
}

function launchFailure(error: unknown): ProcessResult {
  return {
    code: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    signal: null,
    launchError: compactExecutionError(error),
  };
}

async function preflightSimpleVerifyCommand(
  command: string,
  shellExecutable: string,
  shellArgs: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  resolveExecutable: typeof resolveExecutablePath,
  execute: NonNullable<VerifyExecutionOptions["execute"]>,
  signal: AbortSignal | undefined,
): Promise<ProcessResult | null> {
  const shellKind = verifyShellKind(shellExecutable);
  const token = simpleVerifyExecutable(command, shellKind);
  if (!token) return null;
  if (shellKind === "cmd" && isCmdNativeForm(token)) return null;
  if (shellKind === "powershell") {
    const quoted = token.replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; Get-Command -Name '${quoted}' -ErrorAction Stop | Out-Null`;
    const probe = await execute(
      shellExecutable,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      {
        cwd,
        timeoutMs: Math.min(VERIFY_TIMEOUT_MS, 10_000),
        ...(signal ? { signal } : {}),
      },
    );
    return resolutionProbeFailure(token, probe);
  }
  if (shellKind === "posix") {
    const probe = await execute(
      shellExecutable,
      [...shellArgs, 'command -v -- "$1" >/dev/null 2>&1', "orcode-verify-preflight", token],
      {
        cwd,
        timeoutMs: Math.min(VERIFY_TIMEOUT_MS, 10_000),
        ...(signal ? { signal } : {}),
      },
    );
    return resolutionProbeFailure(token, probe);
  }
  await resolveExecutable(token, environment, platform, cwd);
  return null;
}

function resolutionProbeFailure(token: string, probe: ProcessResult): ProcessResult | null {
  if (probe.aborted || probe.timedOut || probe.signal || probe.launchError || probe.code === null) {
    return probe.launchError
      ? { ...probe, code: null, launchError: compactExecutionError(probe.launchError) }
      : probe;
  }
  return probe.code === 0
    ? null
    : launchFailure(`Command could not be resolved: ${token}`);
}

function verifyShellKind(shellExecutable: string): "posix" | "cmd" | "powershell" {
  const name = shellExecutable.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (name === "cmd" || name === "cmd.exe") return "cmd";
  if (name.includes("pwsh") || name.includes("powershell")) return "powershell";
  return "posix";
}

function isCmdNativeForm(token: string): boolean {
  const normalized = token.toLowerCase();
  if (CMD_NATIVE_COMMANDS.has(normalized) || /^[a-z]:$/i.test(token)) return true;
  const slash = normalized.indexOf("/");
  if (slash > 0 && CMD_NATIVE_COMMANDS.has(normalized.slice(0, slash))) return true;
  return /^(?:cd|chdir)(?:\.{1,2}|\\)/i.test(token) || /^(?:echo|rem)[.:]/i.test(token);
}

/** Returns only a literal executable whose first shell segment is safe to inspect. */
function simpleVerifyExecutable(
  command: string,
  shellKind: "posix" | "cmd" | "powershell",
): string | null {
  const trimmed = command.trim();
  if (!trimmed || (shellKind !== "cmd" && trimmed.startsWith("#"))) return null;
  const first = literalFirstShellWord(trimmed, shellKind);
  if (!first || hasAmbiguousShellSuffix(trimmed.slice(first.end), shellKind)) return null;
  const token = first.token;
  if (!token || token.includes("=")) return null;
  if (shellKind === "powershell" && token === ".") return null;
  if (shellKind === "cmd" && token.startsWith(":")) return null;
  if (shellKind === "powershell" && POWERSHELL_LANGUAGE_KEYWORDS.has(token.toLowerCase())) {
    return null;
  }
  return token;
}

function literalFirstShellWord(
  command: string,
  shellKind: "posix" | "cmd" | "powershell",
): { token: string; end: number } | null {
  if (shellKind === "powershell" && (/^['"#-]/.test(command) || /^\d/.test(command))) {
    return null;
  }
  let token = "";
  let quote: "single" | "double" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "single") {
      if (char === "'") quote = null;
      else token += char;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = null;
      } else {
        if ((shellKind === "posix" && (char === "$" || char === "`" || char === "\\")) ||
            (shellKind === "cmd" && (char === "%" || char === "!" || char === "^"))) {
          return null;
        }
        token += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      return token.length > 0 ? { token, end: index } : null;
    }
    if (shellKind === "powershell" && (char === "'" || char === '"')) return null;
    if (char === "'" && shellKind === "posix") {
      quote = "single";
      continue;
    }
    if (char === '"' && shellKind !== "powershell") {
      quote = "double";
      continue;
    }
    if (isAmbiguousFirstWordCharacter(char, shellKind)) return null;
    token += char;
  }
  return !quote && token.length > 0 ? { token, end: command.length } : null;
}

function isAmbiguousFirstWordCharacter(
  char: string,
  shellKind: "posix" | "cmd" | "powershell",
): boolean {
  if (char === "\r" || char === "\n" || char === "|" || char === "&" ||
      char === "<" || char === ">" || char === "(" || char === ")") return true;
  if (shellKind !== "cmd" && char === ";") return true;
  if (shellKind === "posix") {
    return "$`\\*?[]{}!~".includes(char);
  }
  if (shellKind === "powershell") {
    return "$@`*?[]{}".includes(char);
  }
  return "%!^@".includes(char);
}

function hasAmbiguousShellSuffix(
  suffix: string,
  shellKind: "posix" | "cmd" | "powershell",
): boolean {
  let quote: "single" | "double" | null = null;
  for (let index = 0; index < suffix.length; index += 1) {
    const char = suffix[index]!;
    if (quote === "single") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = null;
      } else if ((shellKind === "posix" && char === "\\") ||
                 (shellKind === "powershell" && char === "`") ||
                 (shellKind === "cmd" && char === "^")) {
        if (index + 1 >= suffix.length) return true;
        index += 1;
      }
      continue;
    }
    if ((shellKind === "posix" && char === "\\") ||
        (shellKind === "powershell" && char === "`") ||
        (shellKind === "cmd" && char === "^")) {
      if (index + 1 >= suffix.length) return true;
      index += 1;
      continue;
    }
    if (char === "'" && shellKind !== "cmd") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (char === "\r" || char === "\n" || char === "|" ||
        char === "&" || char === "<" || char === ">" || char === "(" || char === ")") {
      return true;
    }
    if (shellKind !== "cmd" && char === ";") return true;
  }
  return quote !== null;
}

/**
 * F6 formatter/dead-layer consolidation: `src/distill.ts` used to carry a
 * separate, more general tool-output distiller (`distillToolOutput`/
 * `distillDeterministic` — byte-size tiers, an optional >20KB
 * compressor-model call, ANSI/npm-noise cleanup) that was exported and
 * tested but never wired into any production code path — the audit's
 * "orphaned module" finding. This function is the one implementation that
 * survived: it is the one actually in use, it is a better fit for verify's
 * own narrower job (a failure summary bounded by `VERIFY_FAILURE_MAX_CHARS`,
 * not a >20KB model-call tier verify's already-capped output never reaches),
 * and — the deciding factor — it redacts (`redactText`) before anything
 * else, which the orphaned module never did at all; reusing that module
 * here would have silently dropped that redaction step. The dead module and
 * its tests were deleted outright rather than migrated.
 */
function distillFailure(stdout: string, stderr: string): string {
  const combined = redactText(`${stdout}\n${stderr}`).trim();
  if (combined.length === 0) {
    return "";
  }
  const lines = combined.split("\n");
  const matched = lines.filter((line) => FAILURE_LINE_PATTERN.test(line));
  const chosen = matched.length > 0 ? matched : lines.slice(-DISTILL_MAX_LINES);
  const report = chosen.slice(0, DISTILL_MAX_LINES).join("\n").trim();
  if (report.length <= VERIFY_FAILURE_MAX_CHARS) {
    return report;
  }
  const suffix = "\n… truncated …";
  return `${report.slice(0, VERIFY_FAILURE_MAX_CHARS - suffix.length)}${suffix}`;
}
