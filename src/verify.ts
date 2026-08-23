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
const COMMAND_RESOLUTION_EXIT_CODES = new Set([126, 127, 9009]);
const COMMAND_RESOLUTION_DIAGNOSTIC =
  /(?:command not found|not found|not recognized as an internal or external command|cannot execute|permission denied)/i;
const POWERSHELL_RESOLUTION_DIAGNOSTIC =
  /(?:CommandNotFoundException|The term .+ is not recognized as the name of)/i;

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
          let shell: Awaited<ReturnType<typeof resolveCommandShell>>;
          try {
            shell = await resolveCommandShell();
          } catch (error) {
            // Resolution belongs to this visible attempt. Sanitize before the
            // observed terminal callback can expose the configured path.
            throw new Error(compactExecutionError(error));
          }
          const executed = await (execution.execute ?? runProcess)(
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
            ? { ...executed, launchError: compactExecutionError(executed.launchError) }
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
    const resolutionError = commandResolutionError(result);
    if (resolutionError) {
      return { status: "spawn-failed", command, error: resolutionError };
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

function commandResolutionError(result: ProcessResult): string | null {
  if (result.launchError) {
    return compactExecutionError(result.launchError);
  }
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  const conventionalShellFailure =
    COMMAND_RESOLUTION_EXIT_CODES.has(result.code) &&
    COMMAND_RESOLUTION_DIAGNOSTIC.test(detail);
  const powershellFailure =
    result.code !== 0 && POWERSHELL_RESOLUTION_DIAGNOSTIC.test(detail);
  if (!conventionalShellFailure && !powershellFailure) {
    return null;
  }
  return compactExecutionError(
    detail || `Kommando konnte nicht aufgelöst werden (exit ${result.code}).`,
  );
}

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
  const suffix = "\n… gekürzt …";
  return `${report.slice(0, VERIFY_FAILURE_MAX_CHARS - suffix.length)}${suffix}`;
}
