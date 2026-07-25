/**
 * Parser for `~/.ssh/config` (OpenSSH client config syntax): `Host` blocks,
 * `Include` (recursive, depth-limited, cycle-safe), and the handful of
 * keywords orcode needs to reach a host without asking the user to
 * dictate IP/user/credentials again.
 *
 * Deliberately read-only and side-effect free: this module never writes to
 * `~/.ssh/config`, and every entry point takes the path as a parameter so
 * tests never touch the user's real file.
 *
 * Not a full OpenSSH implementation — just enough to resolve `HostName`,
 * `User`, `Port`, `IdentityFile` and `ProxyJump` for a named alias, following
 * OpenSSH's "first obtained value wins" cascade across `Host` blocks.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import fg from "fast-glob";
import { hasCode } from "./utils.js";

export interface SshHost {
  /** The alias as it appears after `Host` — what the user types and what `ssh_command` takes. */
  alias: string;
  /** Resolved `HostName`; defaults to the alias itself, same as OpenSSH. */
  hostName: string;
  user?: string;
  port?: number;
  /** In file order, from the first block that specifies any. */
  identityFile?: string[];
  proxyJump?: string;
}

export interface SshConfigLoadOptions {
  /** Defaults to `~/.ssh/config`. Always pass this in tests. */
  configPath?: string;
  /** Defaults to `os.homedir()`; used to expand `~/` in `Include` arguments. */
  homeDir?: string;
  /** Guards against a pathological Include chain; defaults to 8. */
  maxIncludeDepth?: number;
}

type Entry =
  | { kind: "host"; patterns: string[] }
  | { kind: "set"; key: string; value: string };

interface HostBlock {
  patterns: string[];
  settings: Array<{ key: string; value: string }>;
}

const DEFAULT_MAX_INCLUDE_DEPTH = 8;
const SINGLE_VALUE_KEYS = ["hostname", "user", "port", "proxyjump"] as const;
type SingleValueKey = (typeof SINGLE_VALUE_KEYS)[number];

function isSingleValueKey(key: string): key is SingleValueKey {
  return (SINGLE_VALUE_KEYS as readonly string[]).includes(key);
}

/**
 * Strips a `#` inline comment, but only one that starts a fresh token
 * (preceded by whitespace or at the very start) and outside a quoted value —
 * a `#` inside `"…"` is data, not a comment.
 */
function stripInlineComment(value: string): string {
  let inQuotes = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "#" && !inQuotes && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function parseLine(rawLine: string): { key: string; value: string } | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) {
    return null;
  }
  let key: string;
  let rest: string;
  const equalsMatch = line.match(/^(\S+?)=(.*)$/);
  if (equalsMatch && equalsMatch[1] && !equalsMatch[1].includes(" ")) {
    key = equalsMatch[1];
    rest = equalsMatch[2] ?? "";
  } else {
    const spaceIndex = line.search(/\s/);
    if (spaceIndex === -1) {
      return null; // A bare keyword with no value carries nothing useful.
    }
    key = line.slice(0, spaceIndex);
    rest = line.slice(spaceIndex + 1);
  }
  const value = stripInlineComment(rest).trim();
  return { key: key.toLowerCase(), value };
}

/** Splits on whitespace, respecting `"quoted segments"`. */
function splitArguments(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const token = match[1] ?? match[2] ?? "";
    if (token) tokens.push(token);
  }
  return tokens;
}

/** Resolves one `Include` argument to zero or more concrete file paths. Relative arguments resolve against `~/.ssh` (OpenSSH's own rule), not the includer's directory. */
async function resolveIncludeToken(
  token: string,
  sshDir: string,
  homeDir: string,
): Promise<string[]> {
  let target = token;
  if (target.startsWith("~/")) {
    target = join(homeDir, target.slice(2));
  } else if (!isAbsolute(target)) {
    target = join(sshDir, target);
  }
  if (/[*?[\]]/.test(token)) {
    const matches = await fg(target, {
      onlyFiles: true,
      absolute: true,
      dot: true,
      suppressErrors: true,
    });
    return matches.sort();
  }
  return [target];
}

async function readEntries(
  filePath: string,
  sshDir: string,
  homeDir: string,
  depth: number,
  maxDepth: number,
  visited: Set<string>,
): Promise<Entry[]> {
  if (depth > maxDepth) {
    return [];
  }
  if (visited.has(filePath)) {
    return []; // Cycle guard: an Include chain that loops back stops here.
  }
  visited.add(filePath);

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return []; // A missing config (or a missing Include target) is not an error.
    }
    throw error;
  }

  const entries: Entry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;
    if (parsed.key === "include") {
      for (const token of splitArguments(parsed.value)) {
        const candidates = await resolveIncludeToken(token, sshDir, homeDir);
        for (const candidate of candidates) {
          const nested = await readEntries(
            candidate,
            sshDir,
            homeDir,
            depth + 1,
            maxDepth,
            visited,
          );
          entries.push(...nested);
        }
      }
      continue;
    }
    if (parsed.key === "host") {
      entries.push({ kind: "host", patterns: splitArguments(parsed.value) });
      continue;
    }
    entries.push({ kind: "set", key: parsed.key, value: parsed.value });
  }
  return entries;
}

/** Groups the flat entry stream into blocks. Settings before the first `Host` line behave like an implicit `Host *`. */
function groupBlocks(entries: readonly Entry[]): HostBlock[] {
  const blocks: HostBlock[] = [];
  let current: HostBlock | null = null;
  for (const entry of entries) {
    if (entry.kind === "host") {
      current = { patterns: entry.patterns, settings: [] };
      blocks.push(current);
      continue;
    }
    if (!current) {
      current = { patterns: ["*"], settings: [] };
      blocks.push(current);
    }
    current.settings.push({ key: entry.key, value: entry.value });
  }
  return blocks;
}

/** `*` → any run of characters, `?` → exactly one; everything else is literal. */
function hostPatternToRegExp(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function blockMatchesAlias(patterns: readonly string[], alias: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    const isMatch = hostPatternToRegExp(body).test(alias);
    if (negated && isMatch) return false;
    if (!negated && isMatch) matched = true;
  }
  return matched;
}

/**
 * Every literal (non-wildcard, non-negated) pattern across all blocks — the
 * set of names a user could actually pick. `Host *` and `Host *.example.com`
 * are defaults, never targets.
 */
function collectLiteralAliases(blocks: readonly HostBlock[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (pattern.startsWith("!")) continue;
      if (/[*?]/.test(pattern)) continue;
      if (!seen.has(pattern)) {
        seen.add(pattern);
        ordered.push(pattern);
      }
    }
  }
  return ordered;
}

function resolveHost(alias: string, blocks: readonly HostBlock[]): SshHost {
  const resolved: Partial<Record<SingleValueKey, string>> = {};
  let identityFiles: string[] | undefined;
  for (const block of blocks) {
    if (!blockMatchesAlias(block.patterns, alias)) continue;
    const blockIdentities: string[] = [];
    for (const setting of block.settings) {
      if (setting.key === "identityfile") {
        blockIdentities.push(setting.value);
        continue;
      }
      if (isSingleValueKey(setting.key) && resolved[setting.key] === undefined) {
        resolved[setting.key] = setting.value;
      }
    }
    if (identityFiles === undefined && blockIdentities.length > 0) {
      identityFiles = blockIdentities;
    }
  }
  const host: SshHost = {
    alias,
    hostName: resolved.hostname ?? alias,
  };
  if (resolved.user !== undefined) host.user = resolved.user;
  if (resolved.port !== undefined) {
    const port = Number(resolved.port);
    if (Number.isFinite(port)) host.port = port;
  }
  if (identityFiles && identityFiles.length > 0) host.identityFile = identityFiles;
  if (resolved.proxyjump !== undefined) host.proxyJump = resolved.proxyjump;
  return host;
}

/**
 * Loads and resolves every named host from `~/.ssh/config` (or an injected
 * path). A missing file yields an empty list, never an error — SSH support
 * simply stays inactive until the user has a config.
 */
export async function loadSshHosts(
  options: SshConfigLoadOptions = {},
): Promise<SshHost[]> {
  const homeDir = options.homeDir ?? homedir();
  const configPath = options.configPath ?? join(homeDir, ".ssh", "config");
  const sshDir = dirname(configPath);
  const maxDepth = options.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH;
  const entries = await readEntries(configPath, sshDir, homeDir, 0, maxDepth, new Set());
  const blocks = groupBlocks(entries);
  const aliases = collectLiteralAliases(blocks);
  return aliases.map((alias) => resolveHost(alias, blocks));
}

export function findSshHost(
  alias: string,
  hosts: readonly SshHost[],
): SshHost | undefined {
  return hosts.find((host) => host.alias === alias);
}
