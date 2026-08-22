import type { AgentRunEvent } from "./types.js";

export interface SecretFinding {
  /** Human-readable category used by the outbound warning UI. */
  kind: string;
  /** Number of matches in the scanned text. */
  count: number;
}

export interface SecretRule {
  kind: string;
  pattern: RegExp;
  replacement: string;
  /**
   * A high-confidence but incomplete credential at a persistence boundary.
   * Streaming providers may split the prefix and body across events, so the
   * first half has to be made unreconstructable before either half reaches
   * NDJSON.
   */
  partialPattern?: RegExp;
  partialReplacement?: string;
}

/**
 * The sole registry for both outbound detection and at-rest redaction.
 * Specific formats precede generic ones so a credential is categorized once.
 */
const SECRET_RULES: readonly SecretRule[] = [
  {
    kind: "OpenRouter-Key",
    pattern: /\bsk-or-v1-[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/g,
    replacement: "[REDACTED_OPENROUTER_KEY]",
    partialPattern: /\bsk-or-v1-(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "Anthropic-Key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replacement: "[REDACTED_ANTHROPIC_KEY]",
    partialPattern: /\bsk-ant-(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "API-Key (sk-…)",
    pattern: /\bsk-(?!or-|ant-)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    kind: "AWS-Access-Key",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    replacement: "[REDACTED_AWS_KEY_ID]",
    partialPattern: /\b(?:AKIA|ASIA|ABIA|ACCA)(?![A-Za-z0-9])/g,
  },
  {
    kind: "AWS-Secret-Key",
    pattern:
      /\b(aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}/gi,
    replacement: "$1[REDACTED_AWS_SECRET]",
    partialPattern:
      /\b(aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?)(?![A-Za-z0-9/+=])/gi,
    partialReplacement: "$1[REDACTED_AWS_SECRET]",
  },
  {
    kind: "GitHub-Token",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9_])/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
    partialPattern: /\b(?:gh[pousr]_|github_pat_)(?![A-Za-z0-9_])/g,
  },
  {
    kind: "GitLab-Token",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    replacement: "[REDACTED_GITLAB_TOKEN]",
    partialPattern: /\bglpat-(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "Slack-Token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
    partialPattern: /\bxox[baprs]-(?![A-Za-z0-9-])/g,
  },
  {
    kind: "Google-API-Key",
    pattern: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
    replacement: "[REDACTED_GOOGLE_KEY]",
    partialPattern: /\bAIza(?![A-Za-z0-9_-])/g,
  },
  {
    kind: "npm-Token",
    pattern: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
    replacement: "[REDACTED_NPM_TOKEN]",
    partialPattern: /\bnpm_(?![A-Za-z0-9])/g,
  },
  {
    kind: "Bearer-Token",
    pattern:
      /\bBearer[ \t]+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{20,}(?![A-Za-z0-9._~+/=-])/g,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    kind: "JWT",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9._-])/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    kind: "Private Key",
    pattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
    partialPattern:
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g,
  },
];

/** Scan text and return one finding per category in stable registry order. */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let remaining = text;
  for (const rule of SECRET_RULES) {
    const matches = remaining.match(rule.pattern);
    if (matches?.length) {
      findings.push({ kind: rule.kind, count: matches.length });
      remaining = remaining.replace(rule.pattern, rule.replacement);
    }
  }
  return findings;
}

/** Redact complete secrets while preserving all other bytes. */
export function redactText(text: string): string {
  return redactTextInternal(text, false);
}

function redactTextInternal(text: string, includeStreamingPrefixes: boolean): string {
  let result = text;
  for (const rule of SECRET_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
    if (includeStreamingPrefixes && rule.partialPattern) {
      result = result.replace(
        rule.partialPattern,
        rule.partialReplacement ?? rule.replacement,
      );
    }
  }
  return result;
}

/** Deep-clone a JSON-shaped value while redacting every string leaf. */
export function redactValue<T>(value: T): T {
  return redactValueInternal(value, false);
}

function redactValueInternal<T>(value: T, includeStreamingPrefixes: boolean): T {
  if (typeof value === "string") {
    return redactTextInternal(value, includeStreamingPrefixes) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactValueInternal(item, includeStreamingPrefixes),
    ) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      clone[key] = redactValueInternal(item, includeStreamingPrefixes);
    }
    return clone as T;
  }
  return value;
}

/** Return an independently redacted event for human-readable persistence. */
export function redactRunEvent(event: AgentRunEvent): AgentRunEvent {
  return redactValueInternal(event, true);
}
