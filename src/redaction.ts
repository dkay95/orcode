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
    partialPattern:
      /\bsk-(?!or-|ant-)[A-Za-z0-9]+-(?![A-Za-z0-9_-])/g,
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

const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_COMPLETE = /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/;

interface StreamingSecretIntroducer {
  value: string;
  caseInsensitive?: boolean;
}

const AWS_SECRET_INTRODUCERS: StreamingSecretIntroducer[] = ["", "_", "-"]
  .flatMap((first) => ["", "_", "-"].flatMap((second) =>
    ["", "_", "-"].map((third) => ({
      value: `aws${first}secret${second}access${third}key`,
      caseInsensitive: true,
    })),
  ));

/** Fixed high-confidence starts; the registry regexes remain the final classifier. */
const STREAMING_SECRET_INTRODUCERS: readonly StreamingSecretIntroducer[] = [
  { value: "sk-" },
  { value: "AKIA" },
  { value: "ASIA" },
  { value: "ABIA" },
  { value: "ACCA" },
  ...AWS_SECRET_INTRODUCERS,
  { value: "ghp_" },
  { value: "gho_" },
  { value: "ghu_" },
  { value: "ghs_" },
  { value: "ghr_" },
  { value: "github_pat_" },
  { value: "glpat-" },
  { value: "xoxb-" },
  { value: "xoxa-" },
  { value: "xoxp-" },
  { value: "xoxr-" },
  { value: "xoxs-" },
  { value: "AIza" },
  { value: "npm_" },
  { value: "Bearer " },
  { value: "Bearer\t" },
  { value: "eyJ" },
  { value: "-----BEGIN " },
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

/**
 * Redacts one stdout/stderr text stream without treating a chunk boundary as a
 * credential boundary. Complete lines are released immediately. On a partial
 * line only a possible credential introducer/suffix (or a multi-line private
 * key block) is retained; unrelated output stays live.
 */
class StreamingTextRedactor {
  #pending = "";

  push(text: string): string {
    if (!text) return "";
    this.#pending += text;
    let output = "";
    while (this.#pending) {
      const privateKeyStart = this.#pending.search(PRIVATE_KEY_BEGIN);
      if (privateKeyStart >= 0) {
        if (privateKeyStart > 0) {
          output += redactText(this.#pending.slice(0, privateKeyStart));
          this.#pending = this.#pending.slice(privateKeyStart);
        }
        const complete = this.#pending.match(PRIVATE_KEY_COMPLETE)?.[0];
        if (!complete) return output;
        output += redactText(complete);
        this.#pending = this.#pending.slice(complete.length);
        continue;
      }
      const lastBreak = Math.max(
        this.#pending.lastIndexOf("\n"),
        this.#pending.lastIndexOf("\r"),
      );
      if (lastBreak >= 0) {
        output += redactText(this.#pending.slice(0, lastBreak + 1));
        this.#pending = this.#pending.slice(lastBreak + 1);
        continue;
      }
      const candidateStart = earliestStreamingSecretStart(this.#pending);
      if (candidateStart >= 0) {
        if (candidateStart > 0) {
          output += redactText(this.#pending.slice(0, candidateStart));
          this.#pending = this.#pending.slice(candidateStart);
        }
        return output;
      }
      const overlap = streamingSecretSuffixLength(this.#pending);
      const safeLength = this.#pending.length - overlap;
      if (safeLength > 0) {
        output += redactText(this.#pending.slice(0, safeLength));
        this.#pending = this.#pending.slice(safeLength);
      }
      return output;
    }
    return output;
  }

  flush(): string {
    const output = redactTextInternal(this.#pending, true);
    this.#pending = "";
    return output;
  }
}

function earliestStreamingSecretStart(value: string): number {
  let earliest = -1;
  for (const introducer of STREAMING_SECRET_INTRODUCERS) {
    const haystack = introducer.caseInsensitive ? value.toLowerCase() : value;
    const needle = introducer.caseInsensitive
      ? introducer.value.toLowerCase()
      : introducer.value;
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      if (isStreamingBoundary(value, index, introducer.value[0] ?? "")) {
        if (earliest < 0 || index < earliest) earliest = index;
        break;
      }
      from = index + 1;
    }
  }
  return earliest;
}

function streamingSecretSuffixLength(value: string): number {
  let longest = 0;
  for (const introducer of STREAMING_SECRET_INTRODUCERS) {
    const maximum = Math.min(value.length, introducer.value.length - 1);
    for (let length = maximum; length > longest; length -= 1) {
      const suffix = value.slice(-length);
      const matches = introducer.caseInsensitive
        ? introducer.value.toLowerCase().startsWith(suffix.toLowerCase())
        : introducer.value.startsWith(suffix);
      if (
        matches &&
        isStreamingBoundary(value, value.length - length, introducer.value[0] ?? "")
      ) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

function isStreamingBoundary(value: string, index: number, first: string): boolean {
  if (index === 0 || !/[A-Za-z0-9_]/.test(first)) return true;
  return !/[A-Za-z0-9_]/.test(value[index - 1] ?? "");
}

type ProcessOutputEvent = Extract<AgentRunEvent, { type: "process-output" }>;

interface ProcessStreamState {
  redactor: StreamingTextRedactor;
  template: ProcessOutputEvent;
}

/** Stateful process-event redaction keyed by immutable operation and stream. */
export class ProcessEventRedactor {
  readonly #operations = new Map<
    string,
    Map<"stdout" | "stderr", ProcessStreamState>
  >();

  push(event: AgentRunEvent): AgentRunEvent[] {
    if (event.type === "process-start") {
      this.#operations.delete(event.id);
      return [redactRunEvent(event)];
    }
    if (event.type === "process-output") {
      const streams = this.#operations.get(event.id) ?? new Map();
      const state = streams.get(event.stream) ?? {
        redactor: new StreamingTextRedactor(),
        template: event,
      };
      state.template = event;
      streams.set(event.stream, state);
      this.#operations.set(event.id, streams);
      const text = state.redactor.push(event.text);
      return text ? [redactRunEvent({ ...event, text })] : [];
    }
    if (event.type === "process-end") {
      const flushed = this.#flushOperation(event.id, event.timestamp, event);
      return [...flushed, redactRunEvent(event)];
    }
    if (event.type === "run-end") {
      return [...this.flushAll(event.timestamp), redactRunEvent(event)];
    }
    return [redactRunEvent(event)];
  }

  flushAll(timestamp = Date.now()): AgentRunEvent[] {
    const events: AgentRunEvent[] = [];
    for (const id of [...this.#operations.keys()]) {
      events.push(...this.#flushOperation(id, timestamp));
    }
    return events;
  }

  #flushOperation(
    id: string,
    timestamp: number,
    terminal?: Extract<AgentRunEvent, { type: "process-end" }>,
  ): AgentRunEvent[] {
    const streams = this.#operations.get(id);
    this.#operations.delete(id);
    if (!streams) return [];
    const events: AgentRunEvent[] = [];
    for (const [stream, state] of streams) {
      const text = state.redactor.flush();
      if (!text) continue;
      events.push(redactRunEvent({
        type: "process-output",
        id,
        name: terminal?.name ?? state.template.name,
        stream,
        text,
        ...(terminal?.invocationId !== undefined
          ? { invocationId: terminal.invocationId }
          : state.template.invocationId !== undefined
            ? { invocationId: state.template.invocationId }
            : {}),
        ...(terminal?.toolId !== undefined
          ? { toolId: terminal.toolId }
          : state.template.toolId !== undefined
            ? { toolId: state.template.toolId }
            : {}),
        ...(terminal?.toolNumber !== undefined
          ? { toolNumber: terminal.toolNumber }
          : state.template.toolNumber !== undefined
            ? { toolNumber: state.template.toolNumber }
            : {}),
        timestamp,
      }));
    }
    return events;
  }
}
