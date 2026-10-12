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
  /** Plain-English explanation for the approval prompt. Empty for `allow`. */
  reason: string;
}

export type GitReadOperation = "diff" | "status";

export interface GitReadCapabilityPolicy {
  id: `git.${GitReadOperation}`;
  effect: "read";
  hardened: true;
  /** Read capabilities are declared/evaluated, never stored as mutation rules. */
  rememberable: false;
}

/** Central classification used by both slash commands and model Git tools. */
export function evaluateGitReadCapability(operation: GitReadOperation): GitReadCapabilityPolicy {
  return {
    id: `git.${operation}`,
    effect: "read",
    hardened: true,
    rememberable: false,
  };
}

const ALLOWED: PathPolicyDecision = { verdict: "allow", rule: "none", reason: "" };

/** Directories whose content must never be written without an explicit yes. */
const PROTECTED_WRITE_DIRECTORIES: Array<{ segments: string[]; rule: string; reason: string }> = [
  {
    segments: [".git"],
    rule: "git-metadata",
    reason:
      "Write access to .git/** changes the repository itself (e.g. .git/config), not your code.",
  },
  {
    segments: ["node_modules"],
    rule: "node-modules",
    reason:
      "Write access to node_modules/** changes third-party code that runs on the next start.",
  },
  {
    segments: [".ssh"],
    rule: "ssh-directory",
    reason: "Write access to .ssh/** changes SSH keys and configuration.",
  },
  {
    segments: [".github", "workflows"],
    rule: "github-workflows",
    reason:
      "Write access to .github/workflows/** changes CI jobs that run with your permissions on the next push.",
  },
];

/** Directories whose content is treated as secret material on read. */
const SECRET_READ_DIRECTORIES: Array<{ segments: string[]; rule: string; reason: string }> = [
  {
    segments: [".ssh"],
    rule: "ssh-directory",
    reason: "Private keys live in .ssh/**.",
  },
  {
    segments: [".aws"],
    rule: "aws-directory",
    reason: "AWS credentials live in .aws/**.",
  },
  {
    segments: [".gnupg"],
    rule: "gnupg-directory",
    reason: "Private GPG keys live in .gnupg/**.",
  },
  {
    segments: [".kube"],
    rule: "kube-directory",
    reason: "Cluster credentials live in .kube/** (e.g. tokens in config).",
  },
  {
    segments: [".docker"],
    rule: "docker-directory",
    reason: "Registry credentials live in .docker/** (config.json).",
  },
];

interface NameRule {
  rule: string;
  reason: string;
  test: (name: string) => boolean;
}

/** `.env*`, `.npmrc`, `.netrc`/`_netrc`, `*.pem`, `id_*` — secret on read, protected on write. */
const SECRET_NAME_RULES: NameRule[] = [
  {
    rule: "dotenv",
    reason: "Files with the .env prefix usually contain credentials.",
    test: (name) => name.toLowerCase().startsWith(".env"),
  },
  {
    rule: "npmrc",
    reason: ".npmrc usually contains registry tokens for npm and can redirect registries.",
    test: (name) => name.toLowerCase() === ".npmrc",
  },
  {
    rule: "netrc",
    reason: ".netrc/_netrc usually contains plaintext passwords for remote logins.",
    test: (name) => {
      const lowered = name.toLowerCase();
      return lowered === ".netrc" || lowered === "_netrc";
    },
  },
  {
    rule: "git-credentials",
    reason: ".git-credentials contains plaintext passwords for Git remotes.",
    test: (name) => name.toLowerCase() === ".git-credentials",
  },
  {
    rule: "key-file",
    reason: "Files with this extension usually contain key material.",
    test: (name) => /\.(key|p12|pfx|keystore|jks)$/.test(name.toLowerCase()),
  },
  {
    rule: "pem-file",
    reason: "PEM files usually contain private keys or certificates.",
    test: (name) => name.toLowerCase().endsWith(".pem"),
  },
  {
    rule: "ssh-key",
    reason: "Files with the id_ prefix are usually SSH keys.",
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
    reason: "Files with the credentials prefix usually contain credentials.",
    test: (name) => name.toLowerCase().startsWith("credentials"),
  },
];

export function pathSegments(relativePath: string): string[] {
  return relativePath
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * Case-insensitive on purpose: APFS and NTFS resolve ".GIT" to the real
 * ".git", so a strict comparison would let a differently-cased path walk
 * straight past the hook deny-rule on the two most common filesystems.
 * On case-sensitive filesystems this only over-protects, never under.
 */
function containsSequence(segments: string[], sequence: string[]): boolean {
  if (sequence.length === 0) {
    return false;
  }
  const lowered = segments.map((segment) => segment.toLowerCase());
  for (let index = 0; index + sequence.length <= lowered.length; index += 1) {
    let hit = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (lowered[index + offset] !== sequence[offset].toLowerCase()) {
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
          "Git hooks are blocked: a file under .git/hooks/** would run foreign code on your next git command.",
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
export function assertSafeGlobPattern(pattern: string, label = "Pattern"): void {
  const value = pattern.trim();
  if (value.length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} contains a null byte.`);
  }
  if (isAbsolute(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw new Error(
      `${label} must not be absolute: ${pattern}. Use a relative pattern inside the working directory.`,
    );
  }
  if (/^~/.test(value)) {
    throw new Error(`${label} must not start with ~: ${pattern}.`);
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) {
    throw new Error(
      `${label} must not contain a ..-segment: ${pattern}. It would leave the working directory.`,
    );
  }
}
