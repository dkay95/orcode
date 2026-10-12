import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlyphMode } from "./config.js";
import { createTheme, type Theme } from "./ui/theme.js";

export type ResolvedGlyphMode = "unicode" | "ascii";

export interface GlyphEnvironment {
  readonly ORCODE_ASCII?: string;
  readonly ROUTERCODE_ASCII?: string;
  readonly LANG?: string;
  readonly LC_ALL?: string;
}

const UNICODE_ROUTE_CORE_LARGE = Object.freeze([
  " ╲",
  "   ╲      ──────○",
  "     ❯    ─────────●",
  "   ╱      ──────○",
  " ╱",
  "       ORCODE",
]);

const ASCII_ROUTE_CORE_LARGE = Object.freeze([
  " \\",
  "   \\      ------o",
  "     >    ---------*",
  "   /      ------o",
  " /",
  "       ORCODE",
]);

const UNICODE_ROUTE_CORE_COMPACT = "❯─●";
const ASCII_ROUTE_CORE_COMPACT = ">-*";

export const ROUTE_CORE_WORDMARK = "ORCODE";

export function resolveGlyphMode(
  preference: GlyphMode,
  env: GlyphEnvironment,
): ResolvedGlyphMode {
  if (env.ORCODE_ASCII === "1" || env.ROUTERCODE_ASCII === "1") return "ascii";
  if (preference === "unicode" || preference === "ascii") return preference;

  const locale = env.LC_ALL ?? env.LANG;
  return locale === "C" || locale === "POSIX" ? "ascii" : "unicode";
}

/**
 * V3 audit principle 3 (F5) / F6 theme-accessor dedupe: `commands.ts`'s
 * `commandTheme`, `agent.ts`'s `#theme` and `cli.ts`'s `cliTheme` each
 * re-implemented this exact body — resolve the configured glyph mode, then
 * build a `Theme` with `ascii` set from it — byte-identical apart from
 * which config-ish value they read `appearance.glyphMode` off of. Living
 * next to `resolveGlyphMode` itself, this is the one place that turns a
 * preference into a `Theme`; each surface's thin accessor now only owns
 * extracting its own `glyphMode` field (with its own "no config in this
 * test fixture" fallback) and calls this. Not memoized, for the same
 * reason none of those three were: the caller's config can be mutated in
 * place mid-session (a `/appearance` or other settings command), so this
 * must recompute on every call rather than cache a possibly-stale result.
 */
export function themeForGlyphPreference(preference: GlyphMode, env: GlyphEnvironment): Theme {
  const glyphMode = resolveGlyphMode(preference, env);
  return createTheme({ ascii: glyphMode === "ascii" });
}

export function routeCoreLarge(mode: ResolvedGlyphMode): readonly string[] {
  return mode === "ascii" ? ASCII_ROUTE_CORE_LARGE : UNICODE_ROUTE_CORE_LARGE;
}

export function routeCoreCompact(mode: ResolvedGlyphMode): string {
  return mode === "ascii" ? ASCII_ROUTE_CORE_COMPACT : UNICODE_ROUTE_CORE_COMPACT;
}

/**
 * Reads the version from package.json so it is stated in exactly one
 * place. Works from both src/ (tsx) and dist/ because both sit one level
 * below the root. Lives here rather than in `cli.ts` (D8d, "one source" for
 * the hub's brand block) so `tui.ts` can thread the same version into the
 * welcome box's header row without creating a `tui.ts` → `cli.ts` import
 * cycle (`cli.ts` already imports from `tui.ts`, never the reverse);
 * `cli.ts`'s own `readPackageVersion` re-exports this one unchanged, so
 * every pre-existing caller (`--version`, the plain banner, `renderCliHelp`)
 * keeps working from the same import path.
 */
export function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the placeholder below.
  }
  return "unknown";
}
