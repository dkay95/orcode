export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n… gekürzt …`;
}

export function formatUsd(value: number): string {
  const rendered = value.toFixed(Math.abs(value) < 0.01 ? 5 : 3);
  return "$" + rendered;
}

/**
 * Strips anything that looks like a secret from an environment before it is
 * handed to a child process. Lives here (rather than in workspace.ts, which
 * originally defined it) so both workspace.ts's `run_command`/`git_diff` and
 * browser.ts's headless-browser launch can import it without the two files
 * importing from each other.
 */
export function sanitizedEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (/(key|token|secret|password|credential|authorization|cookie)/i.test(name)) {
      continue;
    }
    result[name] = value;
  }
  return result;
}
