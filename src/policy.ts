/**
 * Central path policy for the workspace sandbox.
 *
 * The policy is deliberately independent of the approval mode. Some paths are
 * dangerous no matter how much trust the user put into the model, because the
 * damage happens later and elsewhere: git hooks run on the next commit,
 * `.env` content leaves the machine as plain text inside a prompt, workflow
 * files run on the next push, and `node_modules` code runs on the next start.
 *
 * `WorkspaceGuard` answers "is this path inside the workspace?".
 * This module answers "is this path inside the workspace *and* harmless?".
 */

import { isAbsolute } from "node:path";

export type PathAccess = "read" | "write";

/** `allow` = no question asked, `approve` = explicit yes required in every mode, `deny` = never. */
export type PolicyVerdict = "allow" | "approve" | "deny";

export interface PathPolicyDecision {
  verdict: PolicyVerdict;
  /** Stable rule id, used in messages and tests. */
  rule: string;
  /** German explanation for the approval prompt. Empty for `allow`. */
  reason: string;
}

const ALLOWED: PathPolicyDecision = { verdict: "allow", rule: "none", reason: "" };

/** Directories whose content must never be written without an explicit yes. */
const PROTECTED_WRITE_DIRECTORIES: Array<{ segments: string[]; rule: string; reason: string }> = [
  {
    segments: [".git"],
    rule: "git-metadata",
    reason:
      "Schreibzugriff auf .git/** ändert das Repository selbst (z. B. .git/config), nicht deinen Code.",
  },
  {
    segments: ["node_modules"],
    rule: "node-modules",
    reason:
      "Schreibzugriff auf node_modules/** ändert fremden Code, der beim nächsten Start ausgeführt wird.",
  },
  {
    segments: [".ssh"],
    rule: "ssh-directory",
    reason: "Schreibzugriff auf .ssh/** verändert SSH-Schlüssel und -Konfiguration.",
  },
  {
    segments: [".github", "workflows"],
    rule: "github-workflows",
    reason:
      "Schreibzugriff auf .github/workflows/** ändert CI-Jobs, die beim nächsten Push mit deinen Rechten laufen.",
  },
];

/** Directories whose content is treated as secret material on read. */
const SECRET_READ_DIRECTORIES: Array<{ segments: string[]; rule: string; reason: string }> = [
  {
    segments: [".ssh"],
    rule: "ssh-directory",
    reason: "In .ssh/** liegen private Schlüssel.",
  },
  {
    segments: [".aws"],
    rule: "aws-directory",
    reason: "In .aws/** liegen Zugangsdaten für AWS.",
  },
];

interface NameRule {
  rule: string;
  reason: string;
  test: (name: string) => boolean;
}

/** `.env*`, `*.pem`, `id_*` — secret on read, protected on write. */
const SECRET_NAME_RULES: NameRule[] = [
  {
    rule: "dotenv",
    reason: "Dateien mit dem Präfix .env enthalten üblicherweise Zugangsdaten.",
    test: (name) => name.toLowerCase().startsWith(".env"),
  },
  {
    rule: "pem-file",
    reason: "PEM-Dateien enthalten üblicherweise private Schlüssel oder Zertifikate.",
    test: (name) => name.toLowerCase().endsWith(".pem"),
  },
  {
    rule: "ssh-key",
    reason: "Dateien mit dem Präfix id_ sind üblicherweise SSH-Schlüssel.",
    // Narrowed against `id_utils.ts` and friends: only extension-less names or
    // the usual key suffixes count as a key.
    test: (name) => /^id_[A-Za-z0-9][A-Za-z0-9_-]*(\.(pub|pem|key))?$/.test(name),
  },
];

/** Additional read-only secret rule: `credentials*`. */
const SECRET_READ_NAME_RULES: NameRule[] = [
  ...SECRET_NAME_RULES,
  {
    rule: "credentials-file",
    reason: "Dateien mit dem Präfix credentials enthalten üblicherweise Zugangsdaten.",
    test: (name) => name.toLowerCase().startsWith("credentials"),
  },
];

export function pathSegments(relativePath: string): string[] {
  return relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
}

function containsSequence(segments: string[], sequence: string[]): boolean {
  if (sequence.length === 0) {
    return false;
  }
  for (let index = 0; index + sequence.length <= segments.length; index += 1) {
    let hit = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (segments[index + offset] !== sequence[offset]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a workspace-relative path.
 *
 * The caller is responsible for making sure the path is inside the workspace;
 * this function only judges what the path *means*.
 */
export function classifyPath(relativePath: string, access: PathAccess): PathPolicyDecision {
  const segments = pathSegments(relativePath);
  if (segments.length === 0) {
    return ALLOWED;
  }
  const name = segments.at(-1) ?? "";

  if (access === "write") {
    if (containsSequence(segments, [".git", "hooks"])) {
      return {
        verdict: "deny",
        rule: "git-hooks",
        reason:
          "Git-Hooks sind gesperrt: eine Datei unter .git/hooks/** würde bei deinem nächsten git-Befehl fremden Code ausführen.",
      };
    }
    for (const directory of PROTECTED_WRITE_DIRECTORIES) {
      if (containsSequence(segments, directory.segments)) {
        return { verdict: "approve", rule: directory.rule, reason: directory.reason };
      }
    }
    for (const rule of SECRET_NAME_RULES) {
      if (rule.test(name)) {
        return { verdict: "approve", rule: rule.rule, reason: rule.reason };
      }
    }
    return ALLOWED;
  }

  for (const directory of SECRET_READ_DIRECTORIES) {
    if (containsSequence(segments, directory.segments)) {
      return { verdict: "approve", rule: directory.rule, reason: directory.reason };
    }
  }
  for (const rule of SECRET_READ_NAME_RULES) {
    if (rule.test(name)) {
      return { verdict: "approve", rule: rule.rule, reason: rule.reason };
    }
  }
  return ALLOWED;
}

/** True when reading this path would hand secret material to the model. */
export function isSecretReadPath(relativePath: string): boolean {
  return classifyPath(relativePath, "read").verdict === "approve";
}

/**
 * Reject glob patterns that can leave the workspace.
 *
 * fast-glob resolves patterns against `cwd`, but an absolute pattern or a `..`
 * segment simply ignores that anchor — the pattern needs the same scrutiny as
 * a path.
 */
export function assertSafeGlobPattern(pattern: string, label = "Muster"): void {
  const value = pattern.trim();
  if (value.length === 0) {
    throw new Error(`${label} darf nicht leer sein.`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} enthält ein Nullbyte.`);
  }
  if (isAbsolute(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw new Error(
      `${label} darf nicht absolut sein: ${pattern}. Nutze ein relatives Muster innerhalb des Arbeitsverzeichnisses.`,
    );
  }
  if (/^~/.test(value)) {
    throw new Error(`${label} darf nicht mit ~ beginnen: ${pattern}.`);
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) {
    throw new Error(
      `${label} darf kein ..-Segment enthalten: ${pattern}. Es würde das Arbeitsverzeichnis verlassen.`,
    );
  }
}
