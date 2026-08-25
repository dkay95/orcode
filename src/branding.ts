import type { GlyphMode } from "./config.js";

export type ResolvedGlyphMode = "unicode" | "ascii";

export interface GlyphEnvironment {
  readonly ORCODE_ASCII?: string;
  readonly ROUTERCODE_ASCII?: string;
  readonly LANG?: string;
  readonly LC_ALL?: string;
}

const UNICODE_ROUTE_CORE_LARGE = [
  "    ╭────────╮         ●",
  "  ╱            ╲      ╱",
  " ╱      ◇       ├────┤",
  "  ╲            ╱      ╲",
  "    ╰────────╯         ○",
  "          ORCODE",
] as const;

const ASCII_ROUTE_CORE_LARGE = [
  "    /--------\\         *",
  "  /            \\      /",
  " <       o       +----+",
  "  \\            /      \\",
  "    \\--------/         o",
  "          ORCODE",
] as const;

const UNICODE_ROUTE_CORE_COMPACT = "⬡─┤●○";
const ASCII_ROUTE_CORE_COMPACT = "<>-+*o";

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

export function routeCoreLarge(mode: ResolvedGlyphMode): readonly string[] {
  return mode === "ascii" ? ASCII_ROUTE_CORE_LARGE : UNICODE_ROUTE_CORE_LARGE;
}

export function routeCoreCompact(mode: ResolvedGlyphMode): string {
  return mode === "ascii" ? ASCII_ROUTE_CORE_COMPACT : UNICODE_ROUTE_CORE_COMPACT;
}
