/**
 * Small, always-loaded half of browser support for `browser_check`/`/browser`
 * (see src/workspace.ts and src/commands.ts): URL classification, the
 * startup temp-artifact sweep, and the shared timeout error type.
 *
 * The heavy half — browser discovery, process spawning, and the CDP client —
 * lives in `browser-engine.ts` and is loaded via dynamic `import()` only
 * when a `browser_check` call actually needs to launch a browser (Phase 7,
 * E-WEIGHT-01). Nothing in this file may import `browser-engine.js`: that
 * would put the heavy module back on the startup path for every session,
 * including ones that never touch the browser tool.
 */

import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalSubject } from "./types.js";
import { errorMessage, hasCode } from "./utils.js";

/** URL authority is the validated origin plus the exact operation, never path/query data. */
export function browserApprovalSubject(
  target: URL,
  operation: string,
): Extract<ApprovalSubject, { kind: "url-operation" }> {
  return { kind: "url-operation", origin: target.origin, operation };
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export interface ConsoleMessageReport {
  level: string;
  text: string;
}

export interface FailedRequestReport {
  url: string;
  status: number | null;
  error?: string;
}

export interface PageReport {
  url: string;
  title: string;
  /**
   * Browser screenshots are operation-local and deleted before `inspectUrl`
   * settles, so a stale path never escapes. This field remains for the 0.4
   * response shape and is always `null` on return.
   */
  screenshotPath: string | null;
  consoleMessages: ConsoleMessageReport[];
  pageErrors: string[];
  failedRequests: FailedRequestReport[];
  loadTimeMs: number;
  /** True when any collected list hit its internal cap (see `MAX_*` below) or the load event never fired within the time budget. */
  truncated: boolean;
}

/** Legacy helper for pre-0.4 callers. Current inspections delete their whole operation tree internally. */
export async function deleteScreenshot(path: string | null): Promise<void> {
  if (!path) {
    return;
  }
  await unlink(path).catch(() => undefined);
}

/**
 * Raised once `inspectUrl`'s hard timeout (browser startup and the whole
 * inspection combined) elapses. Lives in the small eager module — not
 * `browser-engine.ts` — so callers can classify a thrown error via
 * `instanceof` without first loading the heavy engine (a fake `inspectUrlFn`
 * in tests throws this directly, and never touches `browser-engine.ts`).
 */
export class BrowserTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Time limit of ${(timeoutMs / 1_000).toFixed(1)}s reached.`);
    this.name = "BrowserTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const BROWSER_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/**
 * Every name shape below starts with this. `os.tmpdir()` is a directory
 * orcode does not own — on a busy machine it holds hundreds of thousands of
 * unrelated entries — so the sweep rejects a non-candidate with one
 * `startsWith` instead of running three anchored regexes over every name.
 */
const BROWSER_TEMP_NAME_PREFIX = "orcode-browser-";
const BROWSER_OPERATION_NAME = /^orcode-browser-operation-[A-Za-z0-9]{6}$/;
const LEGACY_BROWSER_PROFILE_NAME = /^orcode-browser-profile-[A-Za-z0-9]{6}$/;
const LEGACY_BROWSER_SCREENSHOT_NAME =
  /^orcode-browser-screenshot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/i;

export interface BrowserTempPruneReport {
  removed: string[];
  errors: Array<{ path: string; message: string }>;
}

export interface BrowserTempPruneOptions {
  tempDir?: string;
  nowMs?: number;
  /** Startup cleanup is best effort; this seam keeps removal failures observable and testable. */
  removeEntry?: (path: string) => Promise<void>;
}

/**
 * Removes abandoned browser artifacts from prior processes. Exact generated
 * name shapes, entry type, age, current-user ownership and symlink status all
 * have to agree before deletion; a prefix alone is never authority.
 *
 * Never call this on the blocking launch path (FIX-16/1): the directory it
 * reads is `os.tmpdir()`, which orcode neither owns nor bounds — a machine
 * with 631k entries in it measured 2,274ms here, spent in full before the
 * first frame and wasted whenever no artifact existed. `initializeStartupStorage`
 * now schedules it fire-and-forget after the frame instead (the
 * `refreshDashboardBalance` precedent).
 *
 * The work per entry is also as low as the FS API allows, though measurement
 * says that is the smaller half of the story: no readdir can push a name
 * filter down into the kernel, so the whole directory still has to be
 * enumerated, and at 120k–300k entries the enumeration itself dominates
 * (A/B measured 101ms → 91ms and 353ms → 347ms). What did change:
 *   - the enumeration is no longer sorted — an O(n log n) pass over every
 *     unrelated name in a directory orcode does not own, when only the
 *     handful of matches ever reach the report;
 *   - a non-candidate is rejected by one `startsWith` instead of three
 *     anchored regexes;
 *   - the report — not the directory — is what gets sorted, so callers keep
 *     the stable, deterministic `removed` order they had before.
 * `opendir()` streaming was measured too and came out *slower* than one
 * `readdir()` (per-entry async-iterator overhead beats the array it saves),
 * so the single readdir stays. The remaining floor can only be removed by
 * giving orcode's browser artifacts a directory of their own instead of
 * scattering them through the shared temp root.
 */
export async function pruneBrowserTempArtifacts(
  options: BrowserTempPruneOptions = {},
): Promise<BrowserTempPruneReport> {
  const tempRoot = options.tempDir ?? tmpdir();
  const nowMs = options.nowMs ?? Date.now();
  const removeEntry = options.removeEntry ??
    ((path: string) => rm(path, { recursive: true, force: true }));
  const report: BrowserTempPruneReport = { removed: [], errors: [] };
  let names: string[];
  try {
    names = await readdir(tempRoot);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      report.errors.push({ path: tempRoot, message: errorMessage(error) });
    }
    return report;
  }

  for (const name of names) {
    if (!name.startsWith(BROWSER_TEMP_NAME_PREFIX)) continue;
    const expectedType = browserTempEntryType(name);
    if (!expectedType) continue;
    const path = join(tempRoot, name);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (expectedType === "directory" ? !info.isDirectory() : !info.isFile()) continue;
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
      if (nowMs - info.mtimeMs <= BROWSER_TEMP_MAX_AGE_MS) continue;
      await removeEntry(path);
      report.removed.push(path);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        report.errors.push({ path, message: errorMessage(error) });
      }
    }
  }
  report.removed.sort();
  report.errors.sort((left, right) => left.path.localeCompare(right.path));
  return report;
}

function browserTempEntryType(name: string): "directory" | "file" | null {
  if (BROWSER_OPERATION_NAME.test(name) || LEGACY_BROWSER_PROFILE_NAME.test(name)) {
    return "directory";
  }
  return LEGACY_BROWSER_SCREENSHOT_NAME.test(name) ? "file" : null;
}

// ---------------------------------------------------------------------------
// URL classification (localhost/file:// vs. everything else)
// ---------------------------------------------------------------------------

export const BROWSER_ALLOWED_PROTOCOLS = ["http:", "https:", "file:"] as const;

/**
 * Parses and validates a URL for `browser_check`/`/browser`. Only
 * http/https/file — anything else (`javascript:`, `chrome:`, `data:`, …)
 * is rejected outright, not routed through the approval system, since no
 * approval makes those safe to load headlessly.
 */
export function validateBrowserUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("No URL given.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }
  if (!BROWSER_ALLOWED_PROTOCOLS.includes(parsed.protocol as (typeof BROWSER_ALLOWED_PROTOCOLS)[number])) {
    throw new Error(
      `Unsupported URL scheme "${parsed.protocol}". Allowed: http:, https:, and file:.`,
    );
  }
  return parsed;
}

/** `localhost`, `127.0.0.1`, `::1` (with or without brackets) and any `*.localhost` subdomain. */
export function isLocalHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}
