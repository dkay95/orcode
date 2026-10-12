import { confirm } from "@inquirer/prompts";
import {
  approvalSubjectDisplay,
  exactSubjectMatch,
  normalizeApprovalSubject,
  type RuleStore,
} from "./rules.js";
import type { ApprovalMode, ApprovalSubject, ToolCallPreview, ToolRisk } from "./types.js";
import { truncate } from "./utils.js";
import { createTheme, type Theme } from "./ui/theme.js";

export class PermissionDeniedError extends Error {}

/**
 * D4 controller decision: the one plain-surface confirm primitive. Every
 * Inquirer `confirm()` call in the plain (non-fullscreen) CLI — ~13 in
 * commands.ts, this module's own fallback below — goes through this
 * instead of picking its own `default` ad hoc, so the ordinary/danger
 * grading applies uniformly and is grep-provable (no other `confirm({...})`
 * call remains outside this function). Inquirer stays the actual prompt
 * primitive; this only decides what `default` it gets and what, if
 * anything, is printed before it.
 */
export interface ConfirmPlainRequest {
  /** States the action being confirmed — becomes Inquirer's own message. */
  readonly title: string;
  /**
   * States the consequence: what happens, and what does not happen, if
   * accepted. For a `danger` confirm this prints as its own line BEFORE
   * the prompt (so it survives once Inquirer collapses its own prompt line
   * after an answer, instead of disappearing with it); an `ordinary`
   * confirm folds it into the same multi-line Inquirer message.
   */
  readonly consequence?: string;
}

export interface ConfirmPlainOptions {
  /** Danger keeps `default: false` no matter what — the safe default. */
  readonly danger?: boolean;
  /**
   * Ordinary-only: overrides the class default of `true`. Every call site
   * that sets this documents its own reason (see the D4 report's per-site
   * table) — this is the "unless the call site has a reason" escape hatch,
   * not a free-for-all.
   */
  readonly defaultAccept?: boolean;
}

export async function confirmPlain(
  request: ConfirmPlainRequest,
  options: ConfirmPlainOptions = {},
): Promise<boolean> {
  const danger = options.danger === true;
  if (danger) {
    if (request.consequence) process.stdout.write(`${request.consequence}\n`);
    return confirm({ message: request.title, default: false });
  }
  const message = request.consequence
    ? `${request.title}\n${request.consequence}`
    : request.title;
  return confirm({ message, default: options.defaultAccept ?? true });
}

/**
 * Risk levels used for approval decisions.
 *
 * Identical to `ToolRisk` since types.ts learned `secret-read`; kept as a named
 * alias because approval requests are where the level is decided.
 */
export type ApprovalRisk = ToolRisk;

export interface ApprovalRequest {
  name: string;
  risk: ApprovalRisk;
  summary: string;
  details?: string;
  /**
   * Force an explicit yes regardless of the approval mode. Set by the path
   * policy for protected targets (`.git/**`, `.env*`, `node_modules/**`, …).
   */
  alwaysAsk?: boolean;
  /** Policy rule id that caused `alwaysAsk`; shown to the user. */
  policyRule?: string;
  /** Exact serializable authority identity. Omit when it cannot be derived safely. */
  subject?: ApprovalSubject;
  /** False keeps the exact subject visible but forbids stored authority for this capability. */
  rememberable?: boolean;
}

/** After this many rejections of the same tool the tool is locked for the run. */
export const MAX_DENIALS_PER_RUN = 3;

/**
 * Result of a single approval prompt.
 *
 * `remember` persists a `PermissionRule` for future calls with the same
 * workspace/tool/subject — `"allow"` for "always allow", `"deny"` for "never
 * allow". `reason` is free text explaining a rejection; it is folded into the
 * `PermissionDeniedError` message and therefore reaches the model.
 */
export interface ApprovalDecision {
  accepted: boolean;
  remember?: "allow" | "deny";
  reason?: string;
}

export type ApprovalPromptHandler = (
  preview: ToolCallPreview,
) => Promise<ApprovalDecision>;

type Decision = "allow" | "ask" | "deny";

export interface ApprovalManagerOptions {
  /** Absolute workspace path; scopes remembered rules. */
  workspace?: string;
  ruleStore?: RuleStore;
}

export type OneShotApprovalDecision = "accept" | "decline" | "cancel";

export interface OneShotApprovalReceipt {
  readonly decision: OneShotApprovalDecision;
  readonly request: Readonly<ApprovalRequest>;
  /** Opaque exact-effect binding interpreted only by the issuing adapter. */
  readonly authorityBinding?: object;
}

const ONE_SHOT_APPROVAL_RECEIPTS = new WeakSet<object>();

export class ApprovalManager {
  #mode: ApprovalMode;
  #promptHandler: ApprovalPromptHandler | undefined;
  #denials = new Map<string, number>();
  #lockedTools = new Set<string>();
  #ruleStore: RuleStore | undefined;
  #workspace: string;

  constructor(mode: ApprovalMode, options?: ApprovalManagerOptions) {
    this.#mode = mode;
    this.#ruleStore = options?.ruleStore;
    this.#workspace = options?.workspace ?? "";
  }

  /** Wired in after construction once the rule store has finished loading. */
  setRuleStore(ruleStore: RuleStore, workspace?: string): void {
    this.#ruleStore = ruleStore;
    if (workspace !== undefined) {
      this.#workspace = workspace;
    }
  }

  get mode(): ApprovalMode {
    return this.#mode;
  }

  set mode(value: ApprovalMode) {
    this.#mode = value;
  }

  setPromptHandler(handler?: ApprovalPromptHandler): void {
    this.#promptHandler = handler;
  }

  /**
   * Start a new agent run: clears the per-run rejection budget.
   *
   * Callers may skip this — without it the budget simply keeps counting for
   * the lifetime of the manager, which is the safe direction.
   */
  beginRun(): void {
    this.#denials.clear();
    this.#lockedTools.clear();
  }

  /** Tools that used up their rejection budget in the current run. */
  get lockedTools(): readonly string[] {
    return [...this.#lockedTools];
  }

  async authorize(request: ApprovalRequest): Promise<void> {
    const subject = request.subject ? normalizeApprovalSubject(request.subject) : null;
    const subjectDisplay = subject ? approvalSubjectDisplay(subject) : undefined;
    const rememberable = request.rememberable !== false;

    // (1) Remembered rules — a `deny` rule beats everything, including
    // `allow-all`.
    const ruleDecision =
      rememberable && this.#ruleStore && subject
        ? this.#ruleStore.decide(this.#workspace, request.name, subject)
        : null;
    if (ruleDecision === "deny") {
      throw new PermissionDeniedError(
        `${request.name} was denied by a saved rule (${subjectDisplay}).`,
      );
    }
    // (2) `alwaysAsk` from policy.ts protects a path no matter what a
    // remembered `allow` rule says.
    if (ruleDecision === "allow" && !request.alwaysAsk) {
      return;
    }

    // (3) Fall back to the mode-based decision as before.
    const decision = this.#decide(request);
    if (decision === "allow") {
      return;
    }
    if (decision === "deny") {
      throw new PermissionDeniedError(
        `${request.name} was blocked in read-only mode.`,
      );
    }
    // The budget is about repeated questions, so it only applies where a
    // question would be asked.
    if (this.#lockedTools.has(request.name)) {
      throw new PermissionDeniedError(lockedMessage(request.name));
    }

    const preview = toPreview(request, subject ?? undefined);
    let result: ApprovalDecision;
    if (this.#promptHandler) {
      result = await this.#promptHandler(preview);
    } else {
      // `printPreview` already states the consequence (command, subject,
      // risk notes) before this — a run-tool approval is always danger.
      printPreview(preview);
      const accepted = await confirmPlain(
        { title: `Allow action ${request.name}?` },
        { danger: true },
      );
      result = { accepted };
    }

    if (rememberable && result.remember && this.#ruleStore && subject && exactSubjectMatch(subject)) {
      await this.#ruleStore.remember({
        workspace: this.#workspace,
        tool: request.name,
        subject,
        decision: result.remember,
      });
    }

    if (!result.accepted) {
      const denials = (this.#denials.get(request.name) ?? 0) + 1;
      this.#denials.set(request.name, denials);
      const reasonSuffix = result.reason ? ` Reason: ${result.reason}` : "";
      if (denials >= MAX_DENIALS_PER_RUN) {
        this.#lockedTools.add(request.name);
        throw new PermissionDeniedError(`${lockedMessage(request.name)}${reasonSuffix}`);
      }
      throw new PermissionDeniedError(
        `${request.name} was denied by the user (${denials} of ${MAX_DENIALS_PER_RUN} denials in this run).${reasonSuffix}`,
      );
    }
  }

  #decide(request: ApprovalRequest): Decision {
    if (request.risk === "read") {
      return request.alwaysAsk ? "ask" : "allow";
    }
    if (
      request.risk === "secret-read" ||
      request.risk === "remote-shell" ||
      request.risk === "network-fetch"
    ) {
      // None of these can be "blocked" by read-only in a meaningful way (a
      // read cannot be undone by refusing it after the fact; a remote
      // command or an outbound fetch has no local sandbox to contain it
      // either way), but none may slip through silently — all three always
      // ask, and only `allow-all` skips it.
      return this.#mode === "allow-all" && !request.alwaysAsk ? "allow" : "ask";
    }
    if (this.#mode === "read-only") {
      return "deny";
    }
    if (request.alwaysAsk) {
      return "ask";
    }
    if (this.#mode === "allow-all") {
      return "allow";
    }
    if (this.#mode === "auto-edit" && request.risk === "edit") {
      return "allow";
    }
    return "ask";
  }
}

/** Refuses forged or partial approval authorities before an external adapter is prepared. */
export function assertOrcodeApprovalPolicy(value: unknown): asserts value is ApprovalManager {
  if (!(value instanceof ApprovalManager)
    || !(["read-only", "ask", "auto-edit", "allow-all"] as const).includes(value.mode)) {
    throw new Error("A current Orcode approval policy is required.");
  }
}

/**
 * Resolves exactly one bounded approval without ever persisting authority.
 * The opaque receipt lets the Codex staging boundary distinguish a real
 * ApprovalManager decision from an adapter-supplied `decision: "accept"`.
 */
export async function authorizeOneShotApproval(
  approvals: ApprovalManager,
  request: ApprovalRequest,
  options: Readonly<{
    signal?: AbortSignal;
    deadlineAt?: number;
    now?: () => number;
    authorityBinding?: object;
  }> = {},
): Promise<OneShotApprovalReceipt> {
  assertOrcodeApprovalPolicy(approvals);
  const now = options.now ?? Date.now;
  const boundedRequest = Object.freeze({
    name: request.name,
    risk: request.risk,
    summary: request.summary,
    ...(request.details === undefined ? {} : { details: request.details }),
    ...(request.alwaysAsk === undefined ? {} : { alwaysAsk: request.alwaysAsk }),
    ...(request.policyRule === undefined ? {} : { policyRule: request.policyRule }),
    ...(request.subject === undefined ? {} : { subject: request.subject }),
    rememberable: false,
  }) satisfies Readonly<ApprovalRequest>;
  if (options.signal?.aborted
    || (options.deadlineAt !== undefined && now() >= options.deadlineAt)) {
    return oneShotReceipt("cancel", boundedRequest, options.authorityBinding);
  }

  const authorization = approvals.authorize(boundedRequest);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachAbort: (() => void) | undefined;
  try {
    const guards: Promise<never>[] = [];
    if (options.signal) {
      guards.push(new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new OneShotApprovalCancelled());
        options.signal!.addEventListener("abort", abort, { once: true });
        detachAbort = () => options.signal!.removeEventListener("abort", abort);
      }));
    }
    if (options.deadlineAt !== undefined) {
      const remaining = Math.max(0, options.deadlineAt - now());
      guards.push(new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new OneShotApprovalCancelled()), remaining);
      }));
    }
    await (guards.length === 0 ? authorization : Promise.race([authorization, ...guards]));
    return oneShotReceipt("accept", boundedRequest, options.authorityBinding);
  } catch (error) {
    // If cancellation won the race, retain an observer on the still-running
    // prompt so a later rejection cannot become an unhandled promise. Its
    // `rememberable: false` request can never persist session authority.
    void authorization.catch(() => undefined);
    if (error instanceof PermissionDeniedError) {
      return oneShotReceipt("decline", boundedRequest, options.authorityBinding);
    }
    if (error instanceof OneShotApprovalCancelled
      || options.signal?.aborted
      || (options.deadlineAt !== undefined && now() >= options.deadlineAt)) {
      return oneShotReceipt("cancel", boundedRequest, options.authorityBinding);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detachAbort?.();
  }
}

export function isOneShotApprovalReceipt(value: unknown): value is OneShotApprovalReceipt {
  return typeof value === "object" && value !== null && ONE_SHOT_APPROVAL_RECEIPTS.has(value);
}

/** Consumes, rather than merely recognizes, one opaque approval authority. */
export function consumeOneShotApprovalReceipt(value: unknown): value is OneShotApprovalReceipt {
  return typeof value === "object" && value !== null
    && ONE_SHOT_APPROVAL_RECEIPTS.delete(value);
}

class OneShotApprovalCancelled extends Error {}

function oneShotReceipt(
  decision: OneShotApprovalDecision,
  request: Readonly<ApprovalRequest>,
  authorityBinding?: object,
): OneShotApprovalReceipt {
  const receipt = Object.freeze({
    decision,
    request,
    ...(authorityBinding === undefined ? {} : { authorityBinding }),
  });
  ONE_SHOT_APPROVAL_RECEIPTS.add(receipt);
  return receipt;
}

function lockedMessage(name: string): string {
  return `${name} was denied ${MAX_DENIALS_PER_RUN} times in this run and is locked until the run ends. Rephrase the task or start a new run.`;
}

/**
 * Map an internal request onto the UI-facing preview. The risk level is passed
 * through unchanged; only the policy hints become readable text.
 */
function toPreview(request: ApprovalRequest, subject?: ApprovalSubject): ToolCallPreview {
  const notes: string[] = [];
  if (request.risk === "secret-read") {
    notes.push(
      "Confidential path: the content would be sent to the model as plain text.",
    );
  }
  if (request.risk === "remote-shell" && subject?.kind === "ssh-command") {
    // Structural, not just phrasing in the caller's summary: whatever
    // ssh_command writes as its summary, the host still gets its own,
    // impossible-to-miss line — this is the one piece of chrome that must
    // never depend on someone remembering to word the summary well.
    notes.push(`SSH TARGET (NOT LOCAL): ${subject.host.toUpperCase()}`);
  }
  if (request.risk === "network-fetch") {
    notes.push(
      "External address: the page content (text, scripts, redirects) comes from a third party and is not trustworthy.",
    );
  }
  if (request.alwaysAsk) {
    notes.push(
      `Protected path${request.policyRule ? ` (${request.policyRule})` : ""}: approval is required in every mode.`,
    );
  }
  const details = [...notes, request.details].filter(Boolean).join("\n");
  return {
    name: request.name,
    risk: request.risk,
    summary: request.summary,
    ...(details ? { details } : {}),
    ...(subject ? { subject: approvalSubjectDisplay(subject) } : {}),
    rememberAvailable: subject !== undefined && request.rememberable !== false,
  };
}

export function approvalRiskLabel(risk: ApprovalRisk): string {
  switch (risk) {
    case "shell":
      return "SHELL";
    case "remote-shell":
      return "SSH";
    case "network-fetch":
      return "NETWORK";
    case "edit":
      return "EDIT";
    case "secret-read":
      return "SECRET";
    case "read":
      return "READ";
    default:
      // A risk level added later must never surface as "undefined" in an
      // approval header. Unknown means unclassified, which is the cautious
      // reading, not the harmless one.
      return "UNKNOWN";
  }
}

export function approvalDescription(mode: ApprovalMode): string {
  switch (mode) {
    case "read-only":
      return "Read only; file changes and shell commands are blocked. Reading credential files still asks first.";
    case "ask":
      return "Ask before file changes and every shell command.";
    case "auto-edit":
      return "File changes happen automatically; shell commands still ask first. Protected paths still ask regardless.";
    case "allow-all":
      return "File changes and shell commands run without asking. Dangerous. Only protected paths still ask.";
  }
}

/**
 * V3 audit principle 3 (F5): this module's one shared way to obtain a
 * `Theme` — `ApprovalManager` takes no `config`/`CommandContext` today (it is
 * constructed directly in `cli.ts`, `tui.ts`, and a long list of tests), so
 * there is no `ascii`-bearing config reachable here without threading a new
 * constructor parameter across all of those call sites. `ascii` would only
 * matter if this file called `theme.glyph()`, which it never does — every
 * site below only uses `theme.color()`. Level detection (NO_COLOR/
 * FORCE_COLOR/TTY) still matches chalk's own autodetection exactly, since
 * `createTheme()` defers to it unchanged. Parked for F6, per ruling 5.
 */
function approvalTheme(): Theme {
  return createTheme();
}

function printPreview(preview: ToolCallPreview): void {
  const theme = approvalTheme();
  const risk = riskLabel(preview.risk, theme);
  console.log(`\n${theme.color("warn")("Approval required")} ${risk}`);
  console.log(theme.color("text", { bold: true })(stripControlCharacters(preview.summary)));
  if (preview.subject) {
    console.log(theme.color("muted")(`Applies only to: ${stripControlCharacters(preview.subject)}`));
  }
  if (preview.details) {
    console.log(theme.color("muted")(stripControlCharacters(truncate(preview.details, 5_000))));
  }
}

const OSC_SEQUENCE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const CSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const ESCAPE_SEQUENCE = /\u001B[@-Z\\-_]/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * The plain-mode prompt is the last line of defence before a yes/no, so a tool
 * argument must not be able to redraw it with escape sequences.
 */
function stripControlCharacters(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(UNSAFE_CONTROL, "");
}

/**
 * Exported purely for the F5 pin/parity test (`riskLabel` is otherwise only
 * called from `printPreview` above) — a pure, side-effect-free formatter, so
 * exporting it costs nothing and avoids mocking `console.log` and
 * `@inquirer/prompts`'s `confirm` just to reach it through `authorize()`.
 */
export function riskLabel(risk: ToolRisk, theme: Theme): string {
  if (risk === "remote-shell") {
    // Its own, more emphatic look than local `shell` — a glance must be
    // enough to tell "this leaves the machine" apart from "this doesn't".
    //
    // Ruling 2: background colours are illegal in every level (the theme's
    // iron rule), so the old `bgRed.white.bold` banner maps to the one
    // sanctioned high-attention treatment, `inverse` (+bold) — the codebase's
    // reverse-video role. At level 0 (NO_COLOR) `inverse` degrades to plain
    // text, which would leave just a bare " SSH " floating mid-sentence,
    // reading nothing like the risk badge it is — unlike the other four
    // labels below, which already carry brackets. Brackets are added here
    // (matching their `[SHELL]`/`[EDIT]`/`[SECRET]`/`[READ]` shape) so the
    // safety signal survives on plain text alone, consistent with the
    // NO_COLOR glyph-shape principle. Same words, no meaning change.
    return theme.color("inverse", { bold: true })("[SSH]");
  }
  if (risk === "network-fetch") {
    return theme.color("inverse", { bold: true })("[NETWORK]");
  }
  if (risk === "shell") {
    return theme.color("danger")("[SHELL]");
  }
  if (risk === "edit") {
    return theme.color("warn")("[EDIT]");
  }
  if (risk === "secret-read") {
    // Ruling 1's documented magenta judgment for this site: `secret-read`
    // never changes or destroys anything (nothing is written, deleted, or
    // sent anywhere irreversible) — the risk is confidentiality, i.e.
    // "look before you allow this", not "this cannot be undone". That is
    // the `warn` (caution) bucket, not `danger` (destructive emphasis).
    return theme.color("warn")("[SECRET]");
  }
  return theme.color("ok")("[READ]");
}
