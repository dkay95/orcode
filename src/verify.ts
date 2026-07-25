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
 * Deliberately NOT here: wiring into `agent.ts` (deciding *when* to call
 * `runVerify`, driving the retry-with-model loop across `maxRounds`, turning
 * a failure into a second `callModel` call, or the final `"unverified"` run
 * outcome). See the needsElsewhere note in the task report for the exact
 * integration points.
 */

import {
  DEFAULT_VERIFY,
  VERIFY_MAX_ROUNDS,
  VERIFY_MODES,
  type VerifyConfig,
  type VerifyMode,
} from "./config.js";
import { resolveCommandShell, runProcess, type WorkspaceGuard } from "./workspace.js";
import { isRecord, truncate } from "./utils.js";

// ---------------------------------------------------------------------------
// Config data model
//
// `VerifyConfig`/`VERIFY_MODES`/`VERIFY_MAX_ROUNDS`/the default value are
// owned by `config.ts` — that is where `OrcodeConfigWithBudget.verify`
// actually lives and is persisted. This module re-exports them under their
// original names for backward compatibility, plus its own, deliberately more
// lenient field-by-field validator (`validateVerifyConfig`, used by the
// not-yet-wired `/verify` first-run suggestion flow) which clamps an
// out-of-range `maxRounds` to the nearest bound instead of `validateVerify`'s
// stricter reject-to-default.
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
  if (!isRecord(value)) {
    return { ...DEFAULT_VERIFY_CONFIG };
  }
  return {
    commands: validateCommands(value.commands),
    mode: isVerifyMode(value.mode) ? value.mode : DEFAULT_VERIFY_CONFIG.mode,
    maxRounds: boundedRounds(value.maxRounds),
  };
}

function validateCommands(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function isVerifyMode(value: unknown): value is VerifyMode {
  return typeof value === "string" && (VERIFY_MODES as readonly string[]).includes(value);
}

function boundedRounds(value: unknown): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : NaN;
  if (Number.isNaN(parsed)) {
    return DEFAULT_VERIFY_CONFIG.maxRounds;
  }
  return Math.min(VERIFY_MAX_ROUNDS, Math.max(1, parsed));
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
  | { status: "cancelled" };

const VERIFY_TIMEOUT_MS = 120_000;
const VERIFY_MAX_OUTPUT = 80_000;

/** Same pattern the render layer (2.5) uses to pick the informative lines out of red output. */
const FAILURE_LINE_PATTERN = /(^|\s)(error|ERROR|FAIL|✗|panic|Traceback|error TS\d+)/;
const DISTILL_MAX_LINES = 20;

/**
 * Runs `commands` in order against `guard.root`, stopping at the first
 * non-zero exit. Cancellation (`signal`) always wins over a failure: a run
 * the user aborted mid-verify is `"cancelled"`, never `"failed"`.
 *
 * One call is one verification pass over the full command list — the
 * retry-with-model loop across `VerifyConfig.maxRounds` is the caller's
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
): Promise<VerifyOutcome> {
  for (const command of commands) {
    if (signal?.aborted) {
      return { status: "cancelled" };
    }
    const shell = resolveCommandShell();
    const start = Date.now();
    const result = await runProcess(shell.executable, [...shell.args, command], {
      cwd: guard.root,
      timeoutMs: VERIFY_TIMEOUT_MS,
      signal,
    });
    if (result.aborted) {
      return { status: "cancelled" };
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

function distillFailure(stdout: string, stderr: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  if (combined.length === 0) {
    return "";
  }
  const lines = combined.split("\n");
  const matched = lines.filter((line) => FAILURE_LINE_PATTERN.test(line));
  const chosen = matched.length > 0 ? matched : lines.slice(-DISTILL_MAX_LINES);
  return truncate(chosen.slice(0, DISTILL_MAX_LINES).join("\n").trim(), VERIFY_MAX_OUTPUT);
}
