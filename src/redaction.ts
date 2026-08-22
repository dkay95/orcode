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
      /\b(aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?)(?!\[REDACTED_AWS_SECRET\])(?![A-Za-z0-9/+=])/gi,
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

interface AttributedTextSegment {
  readonly sequence: number;
  text: string;
}

/**
 * Redacts one stdout/stderr text stream without treating a chunk boundary as a
 * credential boundary. Retained fragments keep their immutable arrival
 * sequence so released bytes can return to their original process frame.
 */
class StreamingTextRedactor {
  #pending: AttributedTextSegment[] = [];

  get pendingSequence(): number | undefined {
    return this.#pending[0]?.sequence;
  }

  get pendingLength(): number {
    return this.#pending.reduce((total, segment) => total + segment.text.length, 0);
  }

  push(text: string, sequence: number): AttributedTextSegment[] {
    if (!text) return [];
    appendAttributed(this.#pending, [{ sequence, text }]);
    const output: AttributedTextSegment[] = [];
    while (this.#pending.length > 0) {
      let pendingText = this.#pendingText();
      const privateKeyStart = pendingText.search(PRIVATE_KEY_BEGIN);
      if (privateKeyStart >= 0) {
        if (privateKeyStart > 0) {
          appendAttributed(output, this.#release(privateKeyStart));
          pendingText = this.#pendingText();
        }
        const complete = pendingText.match(PRIVATE_KEY_COMPLETE)?.[0];
        if (!complete) return output;
        appendAttributed(output, this.#release(complete.length));
        continue;
      }
      const lastBreak = Math.max(
        pendingText.lastIndexOf("\n"),
        pendingText.lastIndexOf("\r"),
      );
      if (lastBreak >= 0) {
        appendAttributed(output, this.#release(lastBreak + 1));
        continue;
      }
      const candidateStart = earliestStreamingSecretStart(pendingText);
      if (candidateStart >= 0) {
        if (candidateStart > 0) {
          appendAttributed(output, this.#release(candidateStart));
        }
        return output;
      }
      const overlap = streamingSecretSuffixLength(pendingText);
      const safeLength = pendingText.length - overlap;
      if (safeLength > 0) {
        appendAttributed(output, this.#release(safeLength));
      }
      return output;
    }
    return output;
  }

  flush(): AttributedTextSegment[] {
    return this.#release(this.pendingLength, true);
  }

  /**
   * Break an overlong streaming ambiguity without exposing the retained
   * fragment. Future chunks therefore cannot reconstruct it across the
   * bounded-buffer boundary.
   */
  discardPending(): AttributedTextSegment[] {
    const sequence = this.pendingSequence;
    if (sequence === undefined) return [];
    this.#pending = [];
    return [{ sequence, text: "[REDACTED_STREAM_FRAGMENT]" }];
  }

  #pendingText(): string {
    return this.#pending.map((segment) => segment.text).join("");
  }

  #release(length: number, includeStreamingPrefixes = false): AttributedTextSegment[] {
    const source: AttributedTextSegment[] = [];
    let remaining = length;
    while (remaining > 0) {
      const segment = this.#pending[0];
      if (!segment) break;
      if (segment.text.length <= remaining) {
        source.push(segment);
        this.#pending.shift();
        remaining -= segment.text.length;
      } else {
        source.push({ sequence: segment.sequence, text: segment.text.slice(0, remaining) });
        this.#pending[0] = {
          sequence: segment.sequence,
          text: segment.text.slice(remaining),
        };
        remaining = 0;
      }
    }
    return redactAttributedSegments(source, includeStreamingPrefixes);
  }
}

function redactAttributedSegments(
  segments: AttributedTextSegment[],
  includeStreamingPrefixes: boolean,
): AttributedTextSegment[] {
  let result = segments;
  for (const rule of SECRET_RULES) {
    result = replaceAttributed(result, rule.pattern, rule.replacement);
    if (includeStreamingPrefixes && rule.partialPattern) {
      result = replaceAttributed(
        result,
        rule.partialPattern,
        rule.partialReplacement ?? rule.replacement,
      );
    }
  }
  return result;
}

function replaceAttributed(
  source: AttributedTextSegment[],
  pattern: RegExp,
  replacement: string,
): AttributedTextSegment[] {
  if (source.length === 0) return source;
  const value = source.map((segment) => segment.text).join("");
  const matches = [...value.matchAll(new RegExp(pattern.source, pattern.flags))];
  if (matches.length === 0) return source;

  const output: AttributedTextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    const start = match.index;
    if (start === undefined) continue;
    appendAttributed(output, sliceAttributed(source, cursor, start));
    appendAttributed(output, attributedReplacement(source, start, match, replacement));
    cursor = start + match[0].length;
  }
  appendAttributed(output, sliceAttributed(source, cursor, value.length));
  return output;
}

function attributedReplacement(
  source: AttributedTextSegment[],
  matchStart: number,
  match: RegExpMatchArray,
  replacement: string,
): AttributedTextSegment[] {
  const captureToken = replacement.indexOf("$1");
  if (captureToken < 0 || match[1] === undefined) {
    return [{ sequence: sequenceAt(source, matchStart), text: replacement }];
  }

  const captureOffset = match[0].indexOf(match[1]);
  if (captureOffset < 0) {
    return [{ sequence: sequenceAt(source, matchStart), text: replacement }];
  }
  const captureStart = matchStart + captureOffset;
  const captureEnd = captureStart + match[1].length;
  const output: AttributedTextSegment[] = [];
  const before = replacement.slice(0, captureToken);
  const after = replacement.slice(captureToken + 2);
  if (before) {
    output.push({ sequence: sequenceAt(source, matchStart), text: before });
  }
  appendAttributed(output, sliceAttributed(source, captureStart, captureEnd));
  if (after) {
    output.push({
      sequence: sequenceAt(source, Math.max(captureStart, captureEnd - 1)),
      text: after,
    });
  }
  return output;
}

function sliceAttributed(
  source: AttributedTextSegment[],
  start: number,
  end: number,
): AttributedTextSegment[] {
  if (end <= start) return [];
  const output: AttributedTextSegment[] = [];
  let offset = 0;
  for (const segment of source) {
    const segmentEnd = offset + segment.text.length;
    const sliceStart = Math.max(start, offset);
    const sliceEnd = Math.min(end, segmentEnd);
    if (sliceEnd > sliceStart) {
      appendAttributed(output, [{
        sequence: segment.sequence,
        text: segment.text.slice(sliceStart - offset, sliceEnd - offset),
      }]);
    }
    offset = segmentEnd;
    if (offset >= end) break;
  }
  return output;
}

function sequenceAt(source: AttributedTextSegment[], index: number): number {
  let offset = 0;
  for (const segment of source) {
    if (index < offset + segment.text.length) return segment.sequence;
    offset += segment.text.length;
  }
  return source.at(-1)?.sequence ?? 0;
}

function appendAttributed(
  target: AttributedTextSegment[],
  source: readonly AttributedTextSegment[],
): void {
  for (const segment of source) {
    if (!segment.text) continue;
    const previous = target.at(-1);
    if (previous?.sequence === segment.sequence) {
      previous.text += segment.text;
    } else {
      target.push({ ...segment });
    }
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
  barrier?: BufferedProcessOutput;
}

interface BufferedProcessOutput {
  readonly sequence: number;
  readonly template: ProcessOutputEvent;
  text: string;
  unresolved: boolean;
}

interface ProcessOperationState {
  readonly streams: Map<"stdout" | "stderr", ProcessStreamState>;
  readonly queue: BufferedProcessOutput[];
  readonly entries: Map<number, BufferedProcessOutput>;
  nextSequence: number;
}

// Process producers retain at most 240k per stream. Keep the consumer barrier
// independently bounded as well, including adversarial/direct event callers.
const MAX_BLOCKED_PROCESS_TEXT = 480_000;
const MAX_BLOCKED_PROCESS_EVENTS = 2_048;

/**
 * Stateful process-event redaction keyed by immutable operation and stream.
 * A single per-operation queue prevents either stream from passing an earlier
 * unresolved credential overlap on the other stream.
 */
export class ProcessEventRedactor {
  readonly #operations = new Map<string, ProcessOperationState>();

  push(event: AgentRunEvent): AgentRunEvent[] {
    if (event.type === "process-start") {
      this.#operations.delete(event.id);
      return [redactRunEvent(event)];
    }
    if (event.type === "process-output") {
      let operation = this.#operations.get(event.id);
      if (!operation) {
        operation = {
          streams: new Map(),
          queue: [],
          entries: new Map(),
          nextSequence: 0,
        };
      }
      const state = operation.streams.get(event.stream) ?? {
        redactor: new StreamingTextRedactor(),
      };
      operation.streams.set(event.stream, state);
      this.#operations.set(event.id, operation);

      const buffered: BufferedProcessOutput = {
        sequence: operation.nextSequence++,
        template: event,
        text: "",
        unresolved: false,
      };
      operation.queue.push(buffered);
      operation.entries.set(buffered.sequence, buffered);

      this.#appendSegments(
        operation,
        state.redactor.push(event.text, buffered.sequence),
      );
      this.#updateBarrier(operation, state);

      this.#enforceBounds(operation);
      return this.#drain(operation);
    }
    if (event.type === "process-end") {
      const flushed = this.#flushOperation(event.id, event);
      return [...flushed, redactRunEvent(event)];
    }
    if (event.type === "run-end") {
      return [...this.flushAll(), redactRunEvent(event)];
    }
    return [redactRunEvent(event)];
  }

  flushAll(): AgentRunEvent[] {
    const events: AgentRunEvent[] = [];
    for (const id of [...this.#operations.keys()]) {
      events.push(...this.#flushOperation(id));
    }
    return events;
  }

  #flushOperation(
    id: string,
    terminal?: Extract<AgentRunEvent, { type: "process-end" }>,
  ): AgentRunEvent[] {
    const operation = this.#operations.get(id);
    this.#operations.delete(id);
    if (!operation) return [];
    for (const state of operation.streams.values()) {
      this.#appendSegments(operation, state.redactor.flush());
      this.#updateBarrier(operation, state);
    }
    return this.#drain(operation, terminal);
  }

  #drain(
    operation: ProcessOperationState,
    terminal?: Extract<AgentRunEvent, { type: "process-end" }>,
  ): AgentRunEvent[] {
    const events: AgentRunEvent[] = [];
    while (operation.queue.length > 0) {
      const buffered = operation.queue[0]!;
      if (buffered.text) {
        events.push(this.#outputEvent(buffered, terminal));
        buffered.text = "";
      }
      if (buffered.unresolved) break;
      operation.queue.shift();
      operation.entries.delete(buffered.sequence);
    }
    return events;
  }

  #outputEvent(
    buffered: BufferedProcessOutput,
    terminal?: Extract<AgentRunEvent, { type: "process-end" }>,
  ): AgentRunEvent {
    const template = buffered.template;
    return redactRunEvent({
      ...template,
      text: buffered.text,
      ...(template.invocationId === undefined && terminal?.invocationId !== undefined
        ? { invocationId: terminal.invocationId }
        : {}),
      ...(template.toolId === undefined && terminal?.toolId !== undefined
        ? { toolId: terminal.toolId }
        : {}),
      ...(template.toolNumber === undefined && terminal?.toolNumber !== undefined
        ? { toolNumber: terminal.toolNumber }
        : {}),
    });
  }

  #enforceBounds(operation: ProcessOperationState): void {
    const retainedText = () =>
      operation.queue.reduce((total, item) => total + item.text.length, 0) +
      [...operation.streams.values()].reduce(
        (total, state) => total + state.redactor.pendingLength,
        0,
      );
    while (
      operation.queue.length > MAX_BLOCKED_PROCESS_EVENTS ||
      retainedText() > MAX_BLOCKED_PROCESS_TEXT
    ) {
      const barrier = operation.queue.find((item) => item.unresolved);
      if (!barrier) return;
      const state = [...operation.streams.values()].find(
        (candidate) => candidate.barrier === barrier,
      );
      if (!state) return;
      this.#appendSegments(operation, state.redactor.discardPending());
      this.#updateBarrier(operation, state);
    }
  }

  #appendSegments(
    operation: ProcessOperationState,
    segments: readonly AttributedTextSegment[],
  ): void {
    for (const segment of segments) {
      const buffered = operation.entries.get(segment.sequence);
      if (buffered) buffered.text += segment.text;
    }
  }

  #updateBarrier(
    operation: ProcessOperationState,
    state: ProcessStreamState,
  ): void {
    const sequence = state.redactor.pendingSequence;
    const next = sequence === undefined ? undefined : operation.entries.get(sequence);
    if (state.barrier !== next) {
      if (state.barrier) state.barrier.unresolved = false;
      if (next) next.unresolved = true;
      state.barrier = next;
    }
  }
}
