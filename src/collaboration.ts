import { createHash } from "node:crypto";
import {
  sameRoute,
  type RouteIdentityV1,
} from "./backends.js";
import { redactText, redactValue } from "./redaction.js";
import { validateRouteIdentityV1 } from "./provider-state.js";
import type { VerifyOutcome } from "./verify.js";
import type { CostKnowledge } from "./types.js";

export const DEFAULT_CONTEXT_PACKET_MAX_BYTES = 8 * 1024 * 1024;
export const HARD_CONTEXT_PACKET_MAX_BYTES = 32 * 1024 * 1024;

const DEFAULT_WORKER_TEXT_MAX_BYTES = 512 * 1024;
const HARD_WORKER_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export type CrossRole = "lead" | "challenger";
export type CrossProviderStage =
  | "lead-analysis"
  | "challenger-analysis"
  | "lead-implementation"
  | "challenger-review"
  | "lead-repair"
  | "challenger-repair-review";
export type CrossRunPhase =
  | "idle"
  | "preflight"
  | "analysis"
  | "implementation"
  | "verification"
  | "review"
  | "repair"
  | "completed"
  | "partial"
  | "blocked"
  | "cancelled";

export type CrossTerminalPhase = Extract<
  CrossRunPhase,
  "completed" | "partial" | "blocked" | "cancelled"
>;

export type CrossReason =
  | "missing-routes"
  | "invalid-routes"
  | "unresolved-routes"
  | "same-route"
  | "context-limit"
  | "run-active"
  | "context-mutated"
  | "worker-failed"
  | "worker-limit"
  | "analysis-incomplete"
  | "implementation-incomplete"
  | "verification-failed"
  | "review-failed"
  | "review-blocked"
  | "cost-unknown"
  | "cancelled";

export type CrossVerificationSummary = "not-run" | "passed" | "failed" | "cancelled";

/**
 * FIX-20, finding 1: which side of the pair actually broke, and why.
 *
 * `CrossReason` alone can only ever say "Role run failed" — true, and
 * useless: it names neither the role nor the underlying error, so a blocked
 * frame gave the owner nothing to act on. Every path that used to swallow a
 * worker/verification rejection now records this alongside the reason.
 *
 * `role` is the concrete step that threw — the two pair roles, or the local
 * verification command run. `message` is already humanized (see
 * `CrossCoordinatorOptions.describeFailure`, which production wires to the
 * runtime's own `safeMessage`), already redacted through the same private-
 * value boundary every other cross-published string crosses, single-line,
 * and length-bounded so one runaway provider payload can never take over
 * the result line.
 */
export interface CrossFailureDetailV1 {
  readonly role: CrossRole | "verification";
  readonly message: string;
}

/** Upper bound for a `CrossFailureDetailV1.message` — one status line's worth, never a payload dump. */
const FAILURE_MESSAGE_MAX_CHARS = 180;

export interface ContextPacketV1 {
  readonly version: 1;
  readonly serialized: Uint8Array;
  readonly sha256: string;
  readonly request: string;
  readonly omissions: readonly string[];
}

// ---------------------------------------------------------------------------
// P15 (owner direction 2026-08-28: "beide Modelle müssen wissen, was gerade
// passiert und was die Aufgabe ist … ich möchte nicht den kompletten
// Denkprozess sehen … ich will eine vereinbarte Antwort haben").
//
// The Cross prompt discipline lives here, beside the packet builder both
// roles already share, because all three halves of it are one agreement:
// what a worker is TOLD (`crossRoleBrief`), what it must SEND BACK
// (`crossResponseShape`, embedded in that brief), and how a caller reads that
// back apart again (`parseCrossResponse`). Splitting them across modules is
// exactly how a prompt and its parser drift.
//
// Nothing here touches the ContextPacket: the brief is the sidecar prompt's
// heading, NOT packet content (see `sidecarPacketPrompt`, cli.ts). The gate's
// FIX-10 cost estimate prices the packet (`chatContextChars`), so a longer
// brief cannot silently move the number the owner consented to — the packet
// it prices is byte-identical to what it was before P15.
// ---------------------------------------------------------------------------

/**
 * The agreed section markers. Uppercase in the prompt AND uppercase when
 * parsed — fix round 1 (H1) made the match strict, so these two constants are
 * literally the same token on both sides of the exchange.
 */
export const CROSS_ANSWER_MARKER = "ANSWER";
export const CROSS_REASONING_MARKER = "REASONING";

/**
 * Which call of the coordinator's phase machine a worker is being asked for.
 * Mirrors `CrossWorkerPort`'s three methods, with `implement`'s two distinct
 * situations (first pass, bounded repair round) split apart — the whole point
 * of the brief is that a worker knows WHICH of the two it is in.
 */
export type CrossWorkerStep = "analysis" | "implementation" | "repair" | "review";

const CROSS_STEP_STATE: Readonly<Record<CrossWorkerStep, string>> = Object.freeze({
  analysis: "analysis (step 1 of 3: analysis → implementation → review)",
  implementation: "implementation (step 2 of 3; the analysis of both models is settled)",
  repair: "repair (the single bounded repair round after a blocking review finding)",
  review: "review (step 3 of 3; the workspace change and the verification run are done)",
});

/**
 * Role AND write authority in one sentence. Fix round 1 (L1): the brief used
 * to also take an `authority` field it never read — the two can never
 * disagree in a Cross run (lead writes, challenger does not), so a second
 * source for the same fact was dead weight that a future authority change
 * would have silently ignored. One statement, from one place.
 */
const CROSS_ROLE_STANDING: Readonly<Record<CrossRole, string>> = Object.freeze({
  lead: "lead — the coding model; you are the only worker in this run that may change the workspace",
  challenger: "challenger — the review model; you are strictly read-only and never change the workspace",
});

export interface CrossRoleBriefInput {
  readonly role: CrossRole;
  readonly step: CrossWorkerStep;
  /**
   * The one-sentence job for this exact step — the pre-P15 per-phase role
   * sentence, carried over verbatim rather than rewritten, so the concrete
   * instruction each phase already gave its worker is unchanged.
   */
  readonly job: string;
}

/**
 * What every Cross worker prompt must state (P15 item 2): your role, the
 * phase/state the run is in right now, your job for this step, and the
 * required response shape. Returned as the `heading` `sidecarPacketPrompt`
 * puts above the packet — the packet mechanism itself is untouched.
 *
 * The TASK is deliberately NOT restated here (controller ruling, P15
 * addendum). It already reaches every worker as the packet's own `request`
 * field, which `sidecarPacketPrompt` serializes into the same prompt — one
 * copy of one fact. A second copy would also sit OUTSIDE the packet the
 * gate's cost estimate prices (`chatContextChars`, FIX-10/H1), re-creating
 * exactly the consent-point understatement that fix eliminated. The brief
 * therefore POINTS at the packet's request field instead of duplicating it.
 */
export function crossRoleBrief(input: CrossRoleBriefInput): string {
  return [
    "You are one of two different models working the same task together in an Orcode Cross run.",
    `Your role: ${CROSS_ROLE_STANDING[input.role]}.`,
    `Current phase: ${CROSS_STEP_STATE[input.step]}.`,
    `Your job now: ${input.job}`,
    "The task is the ContextPacket's `request` field below; the packet is the only source of it.",
    crossResponseShape(input.role),
  ].join("\n");
}

/**
 * The "vereinbarte Antwort" contract, stated to the worker. Answer first —
 * that is the part the owner's chat shows; the reasoning is a short summary
 * that rides a folded detail line, never a think-dump in the transcript.
 *
 * A worker that ignores this still renders (see `parseCrossResponse`), so the
 * wording asks rather than threatens: an unparsed reply is a degraded
 * rendering, never an error and never dropped content.
 */
export function crossResponseShape(role: CrossRole): string {
  return [
    "Required response shape — answer first, then a brief reasoning summary:",
    `${CROSS_ANSWER_MARKER}:`,
    role === "challenger"
      ? "  <your finding. Start this line with BLOCKING: if, and only if, it blocks.>"
      : "  <your answer. This is the only part shown in the chat.>",
    `${CROSS_REASONING_MARKER}:`,
    "  <at most 3 short lines saying WHY. A summary — never your full chain of thought.>",
    `Use those two markers on their own lines, ${CROSS_ANSWER_MARKER} before ${CROSS_REASONING_MARKER}.`,
  ].join("\n");
}

export interface CrossResponseParts {
  /**
   * What the chat shows: any preamble the worker wrote before the first
   * marker, followed by its `ANSWER:` sections. Never empty unless the worker
   * produced nothing at all.
   */
  readonly answer: string;
  /**
   * Fix round 1 (M1): the `ANSWER:` sections ALONE, without the preamble
   * `answer` folds in. The agreed shape puts a challenger's verdict on the
   * first line of its ANSWER section, so a caller classifying that verdict
   * (`crossReviewIsBlocking`, cli.ts) must anchor on this — anchoring on
   * `answer` made any lead-in line before `ANSWER:` a silent false negative.
   * Empty whenever no `ANSWER:` marker was found.
   */
  readonly answerSection: string;
  /** The worker's own brief reasoning, verbatim; empty when it produced none. */
  readonly reasoning: string;
  /** True only when the agreed shape was actually found AND yielded an answer. */
  readonly structured: boolean;
}

/**
 * Reader of the agreed shape. The one hard rule: **content is never lost**
 * and this never throws.
 *
 * Fix round 1 (H1) — markers are STRICT, and deliberately so. The pre-fix
 * pattern accepted an optional colon and `#`/`*`/`-`/`>` decoration
 * case-insensitively, which claimed ordinary answer content as structure: a
 * bare `Reasoning` line, a `## Reasoning` sub-heading, a `- answer` bullet,
 * a YAML `answer: 42`, even `Verification: npm test green.`'s neighbours.
 * Everything after such a line was re-labelled `reasoning` — and reasoning is
 * bounded to three lines at PERSIST time (`crossResultBlock`, cli.ts), so the
 * mislabelled text was deleted from the owner's chat for good. A parser whose
 * contract is "nothing is lost" must never be the thing that loses it.
 *
 * A marker is therefore recognised only as: the exact uppercase word, at the
 * very start of a line, followed immediately by a colon. No leading
 * whitespace, no `#`/`*`/`>` decoration, no lowercase, no bare keyword. That
 * is precisely the shape `crossResponseShape` above instructs, so a compliant
 * worker is read exactly as intended and **anything else is content**.
 *
 * Fenced code (``` or ~~~) is skipped while scanning, so a worker that quotes
 * the shape, a YAML block or a diff inside its answer cannot have that quoted
 * text mistaken for structure. An unterminated fence simply keeps the rest of
 * the reply as content — the safe direction, never the lossy one.
 *
 * Degrade rules, all lossless:
 * - No markers at all → the whole text is the answer (`structured: false`).
 * - Text BEFORE the first marker is kept, ahead of the answer's own sections.
 * - Markers found but nothing landed in the answer — a worker that emitted
 *   only `REASONING:` — → the whole original text becomes the answer
 *   (controller ruling, fix round 1: on that path the lossless reading wins;
 *   see the report's fix-round-1 note on M3 for the trade-off it accepts).
 */
const CROSS_MARKER_LINE = new RegExp(
  `^(${CROSS_ANSWER_MARKER}|${CROSS_REASONING_MARKER}):[ \\t]*(.*)$`,
);

/** ``` or ~~~ opening/closing a fenced block; indented fences count. */
const CROSS_CODE_FENCE_LINE = /^\s*(?:```|~~~)/;

export function parseCrossResponse(text: string): CrossResponseParts {
  const raw = typeof text === "string" ? text : "";
  const sections: Array<{ label: "preface" | "answer" | "reasoning"; lines: string[] }> = [
    { label: "preface", lines: [] },
  ];
  let sawMarker = false;
  let insideFence = false;
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    if (CROSS_CODE_FENCE_LINE.test(line)) {
      insideFence = !insideFence;
      sections[sections.length - 1]!.lines.push(line);
      continue;
    }
    const match = insideFence ? null : CROSS_MARKER_LINE.exec(line);
    if (match) {
      sawMarker = true;
      const inline = (match[2] ?? "").trim();
      sections.push({
        label: match[1] === CROSS_ANSWER_MARKER ? "answer" : "reasoning",
        lines: inline ? [inline] : [],
      });
      continue;
    }
    sections[sections.length - 1]!.lines.push(line);
  }
  const collect = (label: "preface" | "answer" | "reasoning"): string =>
    sections
      .filter((section) => section.label === label)
      .map((section) => section.lines.join("\n").trim())
      .filter((value) => value.length > 0)
      .join("\n\n");
  const answerSection = collect("answer");
  const answer = [collect("preface"), answerSection]
    .filter((value) => value.length > 0)
    .join("\n\n");
  if (!sawMarker || answer.trim().length === 0) {
    // Fix round 1 (H1): `raw`, NOT `raw.trim()`. The degrade path's contract
    // is that the answer is the input byte-for-byte, and a trim is already a
    // (whitespace-only) edit of it — which also made the pre-P15 behaviour,
    // where the worker's text was published verbatim, subtly unreproducible.
    // Callers that need to know "did this produce anything" test
    // `answer.trim()` themselves (see `publishCrossResultToSession`, cli.ts).
    return Object.freeze({ answer: raw, answerSection: "", reasoning: "", structured: false });
  }
  return Object.freeze({
    answer,
    answerSection,
    reasoning: collect("reasoning"),
    structured: true,
  });
}

/** How much of a worker's reasoning a folded detail line ever shows. */
export const CROSS_REASONING_SUMMARY_MAX_LINES = 3;
export const CROSS_REASONING_SUMMARY_MAX_CHARS = 200;

/**
 * Bounds a worker's reasoning down to what a `⎿` detail line may carry (P15
 * item 3: "nicht den kompletten Denkprozess sehen"). Returns at most
 * `CROSS_REASONING_SUMMARY_MAX_LINES` lines; whatever it drops it names, so a
 * cut is visible rather than a silently shortened thought.
 *
 * Fix round 1 (L6), stated rather than merely done: each surviving line is
 * also whitespace-COLLAPSED (runs of whitespace become one space, indentation
 * goes). A `⎿` detail is a single terminal line — indentation and code shape
 * cannot survive it, and pretending otherwise would produce a ragged block.
 * Callers that need structure must render the reasoning themselves; this is a
 * summary line, not a document.
 *
 * This is the ONLY lossy step in the P15 path, and it applies exclusively to
 * text the worker itself labelled `REASONING:` — never to answer content
 * (see `parseCrossResponse`'s strict markers, which exist to guarantee that).
 */
export function summarizeCrossReasoning(
  reasoning: string,
  maxLines: number = CROSS_REASONING_SUMMARY_MAX_LINES,
  maxChars: number = CROSS_REASONING_SUMMARY_MAX_CHARS,
): readonly string[] {
  const lines = reasoning
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return Object.freeze([]);
  const kept = lines.slice(0, Math.max(1, maxLines)).map((line) =>
    line.length > maxChars ? `${line.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…` : line,
  );
  const dropped = lines.length - kept.length;
  return Object.freeze(
    dropped > 0 ? [...kept, `… ${dropped} more reasoning line${dropped === 1 ? "" : "s"} not shown`] : kept,
  );
}

export interface CrossPreferencesV1 {
  readonly lead: RouteIdentityV1 | null;
  readonly challenger: RouteIdentityV1 | null;
}

export interface CrossChatContext {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export interface CrossWorkspaceReference {
  readonly path: string;
  readonly sha256?: string;
  readonly excerpt?: string;
}

export interface ContextPacketInput {
  readonly task: string;
  readonly chat?: readonly CrossChatContext[];
  readonly projectInstructions?: readonly string[];
  readonly skillBundleHash?: string | null;
  readonly workspaceReferences?: readonly CrossWorkspaceReference[];
  readonly omissions?: readonly string[];
  readonly maxBytes?: number;
}

export interface CrossStartRequest extends ContextPacketInput {
  readonly lead: RouteIdentityV1 | null;
  readonly challenger: RouteIdentityV1 | null;
  readonly repairBudget: 0 | 1;
}

export interface CrossWorkerPort {
  analyze(input: {
    readonly stage: Extract<CrossProviderStage, "lead-analysis" | "challenger-analysis">;
    readonly role: CrossRole;
    readonly route: RouteIdentityV1;
    readonly context: ContextPacketV1;
    readonly authority: "writer" | "read-only";
    readonly signal: AbortSignal;
  }): Promise<CrossWorkerTextResult>;
  implement(input: {
    readonly stage: Extract<CrossProviderStage, "lead-implementation" | "lead-repair">;
    readonly route: RouteIdentityV1;
    readonly context: ContextPacketV1;
    readonly acceptedPlan: string;
    readonly critique: string;
    readonly repairFinding?: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly text: string;
    readonly changed: boolean;
    readonly outcome: "completed" | "partial" | "blocked";
  } & CrossWorkerUsage>;
  review(input: {
    readonly stage: Extract<CrossProviderStage, "challenger-review" | "challenger-repair-review">;
    readonly route: RouteIdentityV1;
    readonly context: ContextPacketV1;
    readonly leadResult: string;
    readonly diff: string;
    readonly verification: VerifyOutcome;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly blocking: boolean;
    readonly finding: string;
    readonly outcome?: "completed" | "partial" | "blocked";
  } & CrossWorkerUsage>;
}

export interface CrossWorkerUsage {
  readonly costKnowledge?: CostKnowledge;
  readonly costUsd?: number;
  readonly mainCostUsd?: number;
  readonly compressorCostUsd?: number;
}

export interface CrossWorkerTextResult extends CrossWorkerUsage {
  readonly text: string;
  readonly outcome: "completed" | "partial" | "blocked";
}

export interface CrossVerificationPort {
  run(signal: AbortSignal): Promise<{ readonly diff: string; readonly outcome: VerifyOutcome }>;
}

export interface CrossRunSnapshot {
  readonly sequence: number;
  readonly updatedAt: number;
  readonly phase: CrossRunPhase;
  readonly reason: CrossReason | null;
  readonly repairCount: 0 | 1;
  readonly verification: CrossVerificationSummary;
  readonly contextSha256: string | null;
  /** FIX-20: the concrete role + humanized error behind `reason`, when one was actually caught. */
  readonly failure: CrossFailureDetailV1 | null;
}

export interface CrossRunResult {
  readonly phase: CrossTerminalPhase;
  readonly reason: CrossReason | null;
  /** FIX-20: the concrete role + humanized error behind `reason`, when one was actually caught. */
  readonly failure: CrossFailureDetailV1 | null;
  readonly repairCount: 0 | 1;
  readonly verification: CrossVerificationSummary;
  readonly contextSha256: string | null;
  readonly text: string;
  readonly costKnowledge: CostKnowledge;
  readonly costUsd: number;
  readonly mainCostUsd: number;
  readonly compressorCostUsd: number;
  readonly snapshot: CrossRunSnapshot;
}

export interface CrossCoordinatorOptions {
  readonly worker: CrossWorkerPort;
  readonly verification: CrossVerificationPort;
  readonly workerTextMaxBytes?: number;
  readonly now?: () => number;
  readonly onTransition?: (snapshot: CrossRunSnapshot) => void;
  /**
   * FIX-20: translates a caught worker/verification rejection into the
   * plain-English text `CrossFailureDetailV1.message` carries. Production
   * passes the runtime's own `safeMessage` — the exact humanizer every
   * other error surface in the CLI already uses — so a Cross failure reads
   * the same as the identical failure anywhere else.
   *
   * Omitted, NO failure detail is recorded at all and a caught rejection
   * stays exactly as invisible as it was before FIX-20. That is deliberate:
   * a raw `Error.message` can be a verbatim provider response, and this
   * module's standing contract is that such text never leaves it (see
   * tests/collaboration.test.ts, "worker failure aborts and drains the
   * sibling without silent fallback"). Disclosure is opt-in, through a
   * translator the caller vouches for — never a raw default.
   */
  readonly describeFailure?: (error: unknown) => string;
}

interface ActiveRun {
  readonly controller: AbortController;
  cancelRequested: boolean;
  promise: Promise<CrossRunResult>;
  readonly usage: {
    costKnowledge: CostKnowledge;
    costUsd: number;
    mainCostUsd: number;
    compressorCostUsd: number;
  };
}

interface SafeWorkerText {
  readonly text: string;
  readonly withinLimit: boolean;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Builds the only Orcode-owned Cross payload. Object keys are sorted before
 * encoding, every string leaf crosses the existing redaction boundary, and an
 * oversize current request fails instead of being silently truncated.
 */
export function createContextPacketV1(input: ContextPacketInput): ContextPacketV1 {
  return createContextPacket(input, []);
}

function createContextPacket(
  input: ContextPacketInput,
  privateValues: readonly string[],
): ContextPacketV1 {
  const maxBytes = checkedLimit(
    input.maxBytes ?? DEFAULT_CONTEXT_PACKET_MAX_BYTES,
    HARD_CONTEXT_PACKET_MAX_BYTES,
    "context-limit",
  );
  if (typeof input.task !== "string" || input.task.trim().length === 0) {
    throw new Error("context-limit: Cross task must not be empty.");
  }
  const payload = redactCrossValue(redactValue({
    version: 1,
    request: input.task,
    chat: input.chat ?? [],
    projectInstructions: input.projectInstructions ?? [],
    skillBundleHash: input.skillBundleHash ?? null,
    workspaceReferences: input.workspaceReferences ?? [],
    omissions: input.omissions ?? [],
  }), privateValues);
  const canonicalSerialized = new TextEncoder().encode(stableJson(payload));
  if (canonicalSerialized.byteLength > maxBytes) {
    throw new Error(
      `context-limit: serialized ContextPacket is ${canonicalSerialized.byteLength} bytes; limit is ${maxBytes}.`,
    );
  }
  const request = redactPrivateText(input.task, privateValues);
  const omissions = Object.freeze(
    (input.omissions ?? []).map((item) => redactPrivateText(item, privateValues)),
  );
  return Object.freeze({
    version: 1 as const,
    get serialized(): Uint8Array {
      return Uint8Array.from(canonicalSerialized);
    },
    sha256: hashBytes(canonicalSerialized),
    request,
    omissions,
  });
}

export class CrossCoordinator {
  readonly #worker: CrossWorkerPort;
  readonly #verificationPort: CrossVerificationPort;
  readonly #workerTextMaxBytes: number;
  readonly #now: () => number;
  readonly #onTransition?: (snapshot: CrossRunSnapshot) => void;
  readonly #describeFailure: ((error: unknown) => string) | null;
  #sequence = 0;
  #snapshot: CrossRunSnapshot;
  #active: ActiveRun | null = null;
  /**
   * FIX-20: the failure detail caught during the CURRENT run, cleared at
   * every `start()` so a previous run's cause can never be attributed to
   * this one. Only the LAST caught failure is kept: a run ends at its first
   * unrecovered failure, so there is never a second competing cause.
   */
  #failure: CrossFailureDetailV1 | null = null;

  constructor(options: CrossCoordinatorOptions) {
    this.#worker = options.worker;
    this.#verificationPort = options.verification;
    this.#workerTextMaxBytes = checkedLimit(
      options.workerTextMaxBytes ?? DEFAULT_WORKER_TEXT_MAX_BYTES,
      HARD_WORKER_TEXT_MAX_BYTES,
      "worker-limit",
    );
    this.#now = options.now ?? Date.now;
    this.#onTransition = options.onTransition;
    this.#describeFailure = options.describeFailure ?? null;
    this.#snapshot = Object.freeze({
      sequence: 0,
      updatedAt: this.#now(),
      phase: "idle",
      reason: null,
      repairCount: 0,
      verification: "not-run",
      contextSha256: null,
      failure: null,
    });
  }

  start(request: CrossStartRequest): Promise<CrossRunResult> {
    if (!request || (request.repairBudget !== 0 && request.repairBudget !== 1)) {
      return Promise.reject(new TypeError("Cross repair budget must be exactly 0 or 1."));
    }
    if (this.#active) {
      return Promise.resolve(this.#detachedBlockedResult("run-active"));
    }
    let active!: ActiveRun;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.#run(request, active))
      .finally(() => {
        if (this.#active === active) this.#active = null;
      });
    active = {
      controller,
      cancelRequested: false,
      promise,
      usage: {
        costKnowledge: "known",
        costUsd: 0,
        mainCostUsd: 0,
        compressorCostUsd: 0,
      },
    };
    this.#active = active;
    this.#failure = null;
    this.#transition("preflight", {
      reason: null,
      repairCount: 0,
      verification: "not-run",
      contextSha256: null,
      failure: null,
    });
    return promise;
  }

  status(): CrossRunSnapshot {
    return structuredClone(this.#snapshot);
  }

  runActiveResult(): CrossRunResult {
    return this.#detachedBlockedResult("run-active");
  }

  async stop(): Promise<CrossRunSnapshot> {
    const active = this.#active;
    if (!active) return this.status();
    active.cancelRequested = true;
    active.controller.abort();
    await active.promise;
    return this.status();
  }

  async #run(request: CrossStartRequest, active: ActiveRun): Promise<CrossRunResult> {
    if (active.cancelRequested) return this.#terminal("cancelled", "cancelled", "");
    const preflight = preflightRoutes(request.lead, request.challenger);
    if (preflight.kind === "error") {
      return this.#terminal("blocked", preflight.reason, "");
    }

    const lead = preflight.lead;
    const challenger = preflight.challenger;
    const privateRouteValues = [lead.accountFingerprint, challenger.accountFingerprint];

    let context: ContextPacketV1;
    try {
      context = createContextPacket(request, privateRouteValues);
    } catch {
      return this.#terminal("blocked", "context-limit", "");
    }
    this.#transition("analysis", { contextSha256: context.sha256 });

    const analyses = await Promise.allSettled([
      this.#abortOnError(active, () => this.#worker.analyze({
        stage: "lead-analysis",
        role: "lead",
        route: lead,
        context,
        authority: "writer",
        signal: active.controller.signal,
      })),
      this.#abortOnError(active, () => this.#worker.analyze({
        stage: "challenger-analysis",
        role: "challenger",
        route: challenger,
        context,
        authority: "read-only",
        signal: active.controller.signal,
      })),
    ]);
    for (const settled of analyses) {
      if (settled.status === "fulfilled") this.#recordUsage(active, settled.value);
    }
    if (active.cancelRequested) return this.#terminal("cancelled", "cancelled", "");
    if (analyses.some((settled) => settled.status === "rejected")) {
      // FIX-20: `allSettled`'s index IS the role — 0 is lead, 1 is
      // challenger (the array literal above). The first rejection wins:
      // both roles analyze concurrently, so a single provider outage can
      // reject both, and naming one concrete cause beats a joined blur.
      const rejected = analyses.findIndex((settled) => settled.status === "rejected");
      this.#recordFailure(
        rejected === 0 ? "lead" : "challenger",
        (analyses[rejected] as PromiseRejectedResult).reason,
        privateRouteValues,
      );
      return this.#terminal("blocked", "worker-failed", "");
    }
    if (!packetMatchesHash(context)) {
      return this.#terminal("blocked", "context-mutated", "");
    }
    const leadAnalysis = analyses[0].status === "fulfilled" ? analyses[0].value : null;
    const challengerAnalysis = analyses[1].status === "fulfilled" ? analyses[1].value : null;
    if (!leadAnalysis || !challengerAnalysis) {
      return this.#terminal("blocked", "worker-failed", "");
    }
    const safePlan = this.#safeWorkerText(leadAnalysis.text, privateRouteValues);
    const safeCritique = this.#safeWorkerText(challengerAnalysis.text, privateRouteValues);
    if (!safePlan.withinLimit || !safeCritique.withinLimit) {
      return this.#terminal("blocked", "worker-limit", "");
    }
    if (leadAnalysis.outcome !== "completed" || challengerAnalysis.outcome !== "completed") {
      const phase = leadAnalysis.outcome === "partial" || challengerAnalysis.outcome === "partial"
        ? "partial"
        : "blocked";
      return this.#terminal(phase, "analysis-incomplete", "");
    }

    this.#transition("implementation");
    const firstImplementation = await this.#settleOne(active, () => this.#worker.implement({
      stage: "lead-implementation",
      route: lead,
      context,
      acceptedPlan: safePlan.text,
      critique: safeCritique.text,
      signal: active.controller.signal,
    }), "lead", privateRouteValues);
    if (firstImplementation) this.#recordUsage(active, firstImplementation);
    if (active.cancelRequested) return this.#terminal("cancelled", "cancelled", "");
    if (!firstImplementation) return this.#terminal("blocked", "worker-failed", "");
    if (!packetMatchesHash(context)) {
      return this.#terminal("blocked", "context-mutated", "");
    }
    let safeLeadResult = this.#safeWorkerText(firstImplementation.text, privateRouteValues);
    if (!safeLeadResult.withinLimit) {
      return this.#terminal(firstImplementation.changed ? "partial" : "blocked", "worker-limit", "");
    }
    let changed = firstImplementation.changed;
    if (firstImplementation.outcome !== "completed") {
      return this.#terminal(
        changed || firstImplementation.outcome === "partial" ? "partial" : "blocked",
        "implementation-incomplete",
        safeLeadResult.text,
      );
    }

    const firstGate = await this.#verifyAndReview(
      active,
      context,
      challenger,
      safeLeadResult.text,
      "challenger-review",
      privateRouteValues,
    );
    if (firstGate.kind === "terminal") {
      return this.#terminal(
        firstGate.phase === "cancelled" ? "cancelled" : changed ? "partial" : "blocked",
        firstGate.reason,
        firstGate.phase === "cancelled" ? "" : safeLeadResult.text,
      );
    }
    if (!firstGate.blocking) {
      return this.#terminal("completed", null, safeLeadResult.text);
    }
    if (request.repairBudget === 0) {
      return this.#terminal(changed ? "partial" : "blocked", "review-blocked", safeLeadResult.text);
    }

    this.#transition("repair", { repairCount: 1 });
    const repairFinding = this.#safeWorkerText(firstGate.finding, privateRouteValues);
    if (!repairFinding.withinLimit) {
      return this.#terminal(changed ? "partial" : "blocked", "worker-limit", safeLeadResult.text);
    }
    const repair = await this.#settleOne(active, () => this.#worker.implement({
      stage: "lead-repair",
      route: lead,
      context,
      acceptedPlan: safePlan.text,
      critique: safeCritique.text,
      repairFinding: repairFinding.text,
      signal: active.controller.signal,
    }), "lead", privateRouteValues);
    if (repair) this.#recordUsage(active, repair);
    if (active.cancelRequested) return this.#terminal("cancelled", "cancelled", "");
    if (!repair) {
      return this.#terminal(changed ? "partial" : "blocked", "worker-failed", safeLeadResult.text);
    }
    changed ||= repair.changed;
    safeLeadResult = this.#safeWorkerText(repair.text, privateRouteValues);
    if (!safeLeadResult.withinLimit) {
      return this.#terminal(changed ? "partial" : "blocked", "worker-limit", "");
    }
    if (repair.outcome !== "completed") {
      return this.#terminal(
        changed || repair.outcome === "partial" ? "partial" : "blocked",
        "implementation-incomplete",
        safeLeadResult.text,
      );
    }
    const secondGate = await this.#verifyAndReview(
      active,
      context,
      challenger,
      safeLeadResult.text,
      "challenger-repair-review",
      privateRouteValues,
    );
    if (secondGate.kind === "terminal") {
      return this.#terminal(
        secondGate.phase === "cancelled" ? "cancelled" : changed ? "partial" : "blocked",
        secondGate.reason,
        secondGate.phase === "cancelled" ? "" : safeLeadResult.text,
      );
    }
    if (secondGate.blocking) {
      return this.#terminal(changed ? "partial" : "blocked", "review-blocked", safeLeadResult.text);
    }
    return this.#terminal("completed", null, safeLeadResult.text);
  }

  async #verifyAndReview(
    active: ActiveRun,
    context: ContextPacketV1,
    challenger: RouteIdentityV1,
    leadResult: string,
    stage: Extract<CrossProviderStage, "challenger-review" | "challenger-repair-review">,
    privateRouteValues: readonly string[],
  ): Promise<
    | { readonly kind: "review"; readonly blocking: boolean; readonly finding: string }
    | { readonly kind: "terminal"; readonly phase: "blocked" | "cancelled"; readonly reason: CrossReason }
  > {
    const repairRound = stage === "challenger-repair-review";
    if (!repairRound) this.#transition("verification");
    const verified = await this.#settleOne(
      active,
      () => this.#verificationPort.run(active.controller.signal),
      "verification",
      privateRouteValues,
    );
    if (active.cancelRequested || verified?.outcome.status === "cancelled") {
      this.#transition(repairRound ? "repair" : "verification", { verification: "cancelled" });
      return { kind: "terminal", phase: "cancelled", reason: "cancelled" };
    }
    if (!verified) return { kind: "terminal", phase: "blocked", reason: "verification-failed" };
    const verificationSummary: CrossVerificationSummary = verified.outcome.status === "passed"
      ? "passed"
      : "failed";
    this.#transition(repairRound ? "repair" : "review", { verification: verificationSummary });
    const safeDiff = this.#safeWorkerText(verified.diff, privateRouteValues);
    if (!safeDiff.withinLimit) {
      return { kind: "terminal", phase: "blocked", reason: "worker-limit" };
    }
    const reviewed = await this.#settleOne(active, () => this.#worker.review({
      stage,
      route: challenger,
      context,
      leadResult,
      diff: safeDiff.text,
      verification: redactCrossValue(verified.outcome, privateRouteValues) as VerifyOutcome,
      signal: active.controller.signal,
    }), "challenger", privateRouteValues);
    if (reviewed) this.#recordUsage(active, reviewed);
    if (active.cancelRequested) {
      return { kind: "terminal", phase: "cancelled", reason: "cancelled" };
    }
    if (!reviewed) return { kind: "terminal", phase: "blocked", reason: "review-failed" };
    if (this.#costsUnknown(active)) {
      return { kind: "terminal", phase: "blocked", reason: "cost-unknown" };
    }
    if ((reviewed.outcome ?? "completed") !== "completed") {
      return { kind: "terminal", phase: "blocked", reason: "review-failed" };
    }
    if (!packetMatchesHash(context)) {
      return { kind: "terminal", phase: "blocked", reason: "context-mutated" };
    }
    const safeFinding = this.#safeWorkerText(reviewed.finding, privateRouteValues);
    if (!safeFinding.withinLimit) {
      return { kind: "terminal", phase: "blocked", reason: "worker-limit" };
    }
    if (verified.outcome.status !== "passed") {
      return { kind: "terminal", phase: "blocked", reason: "verification-failed" };
    }
    return {
      kind: "review",
      blocking: reviewed.blocking,
      finding: safeFinding.text,
    };
  }

  /**
   * FIX-20: still resolves `null` on a rejection exactly as before — the
   * phase machine's own control flow is untouched — but no longer discards
   * WHAT went wrong on the way. `role` names the step the caller was
   * running, so a `null` here always has a matching, attributable
   * `#failure` for the terminal frame to render.
   */
  async #settleOne<T>(
    active: ActiveRun,
    start: () => Promise<T>,
    role: CrossFailureDetailV1["role"],
    privateValues: readonly string[],
  ): Promise<T | null> {
    try {
      return await start();
    } catch (error) {
      this.#recordFailure(role, error, privateValues);
      return null;
    }
  }

  /**
   * FIX-20: humanize, redact, flatten, bound — in that order. The humanizer
   * is the caller's own (`describeFailure`), so a Cross failure reads like
   * the identical failure on every other surface; redaction runs AFTER it,
   * over the produced text, because a humanizer can legitimately surface
   * request detail this run's own route values must never leave in.
   *
   * With no humanizer configured, nothing is recorded — a raw error text is
   * never a fallback here (see `CrossCoordinatorOptions.describeFailure`).
   */
  #recordFailure(
    role: CrossFailureDetailV1["role"],
    error: unknown,
    privateValues: readonly string[],
  ): void {
    if (!this.#describeFailure) return;
    let described: string;
    try {
      described = this.#describeFailure(error);
    } catch {
      // A humanizer that itself throws discloses nothing: falling back to
      // the raw error here would reintroduce exactly the leak this opt-in
      // design exists to prevent.
      return;
    }
    const flattened = redactPrivateText(redactText(described), privateValues)
      .replace(/\s+/g, " ")
      .trim();
    if (!flattened) return;
    this.#failure = Object.freeze({
      role,
      message: flattened.length > FAILURE_MESSAGE_MAX_CHARS
        ? `${flattened.slice(0, FAILURE_MESSAGE_MAX_CHARS - 1).trimEnd()}…`
        : flattened,
    });
  }

  async #abortOnError<T>(active: ActiveRun, start: () => Promise<T>): Promise<T> {
    try {
      return await start();
    } catch (error) {
      if (!active.cancelRequested) active.controller.abort();
      throw error;
    }
  }

  #safeWorkerText(text: string, privateValues: readonly string[]): SafeWorkerText {
    if (typeof text !== "string") return { text: "", withinLimit: false };
    const safe = redactPrivateText(text, privateValues);
    return {
      text: safe,
      withinLimit: Buffer.byteLength(safe, "utf8") <= this.#workerTextMaxBytes,
    };
  }

  #recordUsage(active: ActiveRun, result: CrossWorkerUsage): void {
    if (result.costKnowledge === "unknown") active.usage.costKnowledge = "unknown";
    active.usage.costUsd += nonNegativeCost(result.costUsd);
    active.usage.mainCostUsd += nonNegativeCost(result.mainCostUsd);
    active.usage.compressorCostUsd += nonNegativeCost(result.compressorCostUsd);
  }

  #costsUnknown(active: ActiveRun): boolean {
    return active.usage.costKnowledge === "unknown";
  }

  #transition(
    phase: CrossRunPhase,
    patch: Partial<Omit<CrossRunSnapshot, "sequence" | "phase">> = {},
  ): void {
    this.#sequence += 1;
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...patch,
      sequence: this.#sequence,
      updatedAt: this.#now(),
      phase,
    });
    this.#onTransition?.(this.status());
  }

  #terminal(phase: CrossTerminalPhase, reason: CrossReason | null, text: string): CrossRunResult {
    // FIX-20: the caught cause travels with the terminal state, on both the
    // snapshot (what the live surfaces read) and the result (what the
    // published frame reads) — one recorded fact, never re-derived.
    this.#transition(phase, { reason, failure: this.#failure });
    const snapshot = this.status();
    return Object.freeze({
      phase,
      reason,
      failure: snapshot.failure,
      repairCount: snapshot.repairCount,
      verification: snapshot.verification,
      contextSha256: snapshot.contextSha256,
      text: redactText(text),
      costKnowledge: this.#active?.usage.costKnowledge ?? "known",
      costUsd: this.#active?.usage.costUsd ?? 0,
      mainCostUsd: this.#active?.usage.mainCostUsd ?? 0,
      compressorCostUsd: this.#active?.usage.compressorCostUsd ?? 0,
      snapshot,
    });
  }

  #detachedBlockedResult(reason: CrossReason): CrossRunResult {
    const snapshot: CrossRunSnapshot = Object.freeze({
      ...this.status(),
      phase: "blocked",
      reason,
      failure: null,
    });
    return Object.freeze({
      phase: "blocked",
      reason,
      // A detached rejection (`run-active`) never ran a worker of its own —
      // there is no caught cause to attribute, and the reason says it all.
      failure: null,
      repairCount: snapshot.repairCount,
      verification: snapshot.verification,
      contextSha256: null,
      text: "",
      costKnowledge: "known",
      costUsd: 0,
      mainCostUsd: 0,
      compressorCostUsd: 0,
      snapshot,
    });
  }
}

function preflightRoutes(
  lead: RouteIdentityV1 | null,
  challenger: RouteIdentityV1 | null,
):
  | { readonly kind: "ok"; readonly lead: RouteIdentityV1; readonly challenger: RouteIdentityV1 }
  | {
    readonly kind: "error";
    readonly reason: Extract<
      CrossReason,
      "missing-routes" | "invalid-routes" | "unresolved-routes" | "same-route"
    >;
  } {
  if (!lead || !challenger) return { kind: "error", reason: "missing-routes" };
  const validatedLead = validateCrossRoute(lead);
  const validatedChallenger = validateCrossRoute(challenger);
  if (!validatedLead || !validatedChallenger) {
    return { kind: "error", reason: "invalid-routes" };
  }
  if (
    validatedLead.resolutionState !== "resolved"
    || validatedLead.canonicalModelId === null
    || validatedChallenger.resolutionState !== "resolved"
    || validatedChallenger.canonicalModelId === null
  ) return { kind: "error", reason: "unresolved-routes" };
  if (sameRoute(validatedLead, validatedChallenger)) {
    return { kind: "error", reason: "same-route" };
  }
  return {
    kind: "ok",
    lead: Object.freeze(validatedLead),
    challenger: Object.freeze(validatedChallenger),
  };
}

const ROUTE_KEYS = Object.freeze([
  "version",
  "backendId",
  "accountFingerprint",
  "billingRealm",
  "requestedModelId",
  "canonicalModelId",
  "resolutionState",
] as const);

function validateCrossRoute(route: RouteIdentityV1): RouteIdentityV1 | null {
  const validated = validateRouteIdentityV1(route);
  if (
    !validated
    || !hasExactKeys(route as unknown as Record<string, unknown>, ROUTE_KEYS)
    || validated.accountFingerprint.length > 512
    || /\s|@/.test(validated.accountFingerprint)
  ) return null;
  const realmMatchesBackend = validated.backendId === "openrouter"
    ? validated.billingRealm === "openrouter-payg"
    : validated.backendId === "kimi-code"
    ? validated.billingRealm === "kimi-code-membership-provider-managed-overage"
    : validated.backendId === "nano-gpt"
    ? validated.billingRealm === "nanogpt-subscription" || validated.billingRealm === "nanogpt-payg"
    : validated.backendId === "codex"
    ? validated.billingRealm === "chatgpt-subscription-provider-managed-overage"
      || validated.billingRealm === "chatgpt-account-provider-managed-limits"
    : false;
  return realmMatchesBackend ? validated : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function packetMatchesHash(packet: ContextPacketV1): boolean {
  return hashBytes(packet.serialized) === packet.sha256;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedLimit(value: number, hardMaximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > hardMaximum) {
    throw new Error(`${code}: byte limit must be between 1 and ${hardMaximum}.`);
  }
  return value;
}

function nonNegativeCost(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function stableJson(value: unknown): string {
  return JSON.stringify(toStableJsonValue(value));
}

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function redactPrivateText(text: string, privateValues: readonly string[]): string {
  let safe = redactText(text).replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
  const values = [...new Set(privateValues.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const value of values) safe = safe.split(value).join("[REDACTED_ACCOUNT]");
  return safe;
}

function redactCrossValue(value: unknown, privateValues: readonly string[]): unknown {
  if (typeof value === "string") return redactPrivateText(value, privateValues);
  if (Array.isArray(value)) {
    return value.map((item) => redactCrossValue(item, privateValues));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactCrossValue(item, privateValues)]),
    );
  }
  return value;
}

function toStableJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("context-limit: cyclic ContextPacket input.");
    seen.add(value);
    const result = value.map((item) => toStableJsonValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("context-limit: cyclic ContextPacket input.");
    seen.add(value);
    const source = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      result[key] = toStableJsonValue(item, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error("context-limit: ContextPacket input must be JSON-shaped.");
}
