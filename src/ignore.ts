import { readFile, stat } from "node:fs/promises";
import { sep } from "node:path";

/**
 * `.gitignore` subset orcode understands.
 *
 * Supported: comments (`#`), blank lines, negation (`!`), an anchoring `/` at
 * the start (or anywhere in the middle, which anchors implicitly per the real
 * gitignore rules), a trailing `/` for directory-only patterns, `*`, `?` and
 * `**`.
 *
 * Not supported: character classes (`[a-z]`) and backslash escapes. Lines
 * using them are skipped and counted in `unsupportedCount`, so callers can
 * surface an honest note instead of silently mis-filtering.
 */
export interface IgnoreMatcher {
  matches(relativePath: string, isDirectory: boolean): boolean;
  readonly unsupportedCount: number;
}

interface CompiledRule {
  negate: boolean;
  regex: RegExp;
}

interface CacheEntry {
  matcher: IgnoreMatcher;
  mtimeMs: number | null;
}

const cache = new Map<string, CacheEntry>();

/**
 * Loads and compiles the workspace root's `.gitignore`. Cached per root and
 * invalidated by the file's mtime, so repeated `list_files`/search calls
 * within one process do not re-read and re-parse it every time.
 */
export async function loadIgnore(root: string): Promise<IgnoreMatcher> {
  const path = `${root}${sep}.gitignore`;
  let mtimeMs: number | null = null;
  let content = "";
  try {
    const info = await stat(path);
    mtimeMs = info.mtimeMs;
    content = await readFile(path, "utf8");
  } catch {
    // No .gitignore: an empty matcher that ignores nothing.
  }

  const cached = cache.get(root);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.matcher;
  }

  const { rules, unsupportedCount } = compileGitignore(content);
  const matcher: IgnoreMatcher = {
    unsupportedCount,
    matches(relativePath: string): boolean {
      const normalized = normalizePath(relativePath);
      let ignored = false;
      for (const rule of rules) {
        if (rule.regex.test(normalized)) {
          ignored = !rule.negate;
        }
      }
      return ignored;
    },
  };
  cache.set(root, { matcher, mtimeMs });
  return matcher;
}

function normalizePath(relativePath: string): string {
  return relativePath.split(sep).join("/").replace(/^\.\//, "");
}

function compileGitignore(content: string): {
  rules: CompiledRule[];
  unsupportedCount: number;
} {
  const rules: CompiledRule[] = [];
  let unsupportedCount = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    const compiled = compilePattern(line);
    if (compiled === null) {
      unsupportedCount += 1;
      continue;
    }
    rules.push(compiled);
  }
  return { rules, unsupportedCount };
}

/** Returns `null` when the line uses an unsupported gitignore feature. */
function compilePattern(line: string): CompiledRule | null {
  let pattern = line;
  let negate = false;
  if (pattern.startsWith("!")) {
    negate = true;
    pattern = pattern.slice(1);
  }
  // Backslash escapes and character classes are the two documented gaps.
  if (pattern.includes("\\") || pattern.includes("[")) {
    return null;
  }
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern.length === 0) {
    return null;
  }
  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  // A `/` anywhere but at the very end also anchors the pattern to the
  // directory the .gitignore lives in (real gitignore semantics).
  if (pattern.includes("/")) {
    anchored = true;
  }

  const core = translateGlob(pattern);
  const prefix = anchored ? "" : "(?:.*/)?";
  const suffix = dirOnly ? "(?:/.*)?" : "";
  const regex = new RegExp(`^${prefix}${core}${suffix}$`);
  return { negate, regex };
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/;

function translateGlob(pattern: string): string {
  let out = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        out += "(?:.*/)?";
        index += 3;
        continue;
      }
      if (index + 2 === pattern.length) {
        out += ".*";
        index += 2;
        continue;
      }
      out += "[^/]*";
      index += 2;
      continue;
    }
    if (char === "*") {
      out += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }
    out += REGEX_SPECIALS.test(char) ? `\\${char}` : char;
    index += 1;
  }
  return out;
}
