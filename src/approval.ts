import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { deriveCommandSubject, type RuleStore } from "./rules.js";
import type { ApprovalMode, ToolCallPreview, ToolRisk } from "./types.js";
import { truncate } from "./utils.js";

export class PermissionDeniedError extends Error {}

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
  /**
   * Raw shell command for `risk: "shell"` requests. Used to derive the rule
   * subject (`deriveCommandSubject`) — never matched literally, so `npm test`
   * and `npm test --watch` share a rule.
   */
  command?: string;
  /**
   * Workspace-relative path for file-tool requests. Used verbatim as the rule
   * subject (`path-glob` matching).
   */
  path?: string;
  /**
   * Remote host alias for `risk: "remote-shell"` requests (`ssh_command`).
   * Folded into the rule subject ahead of `command`/`path` so a remembered
   * rule for one host can never bleed into another — see `subjectOf`.
   */
  host?: string;
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
    const subject = subjectOf(request);

    // (1) Remembered rules — a `deny` rule beats everything, including
    // `allow-all`.
    const ruleDecision =
      this.#ruleStore && subject !== undefined
        ? this.#ruleStore.decide(this.#workspace, request.name, subject)
        : null;
    if (ruleDecision === "deny") {
      throw new PermissionDeniedError(
        `${request.name} wurde durch eine gespeicherte Regel abgelehnt (${subject}).`,
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
        `${request.name} wurde im read-only-Modus blockiert.`,
      );
    }
    // The budget is about repeated questions, so it only applies where a
    // question would be asked.
    if (this.#lockedTools.has(request.name)) {
      throw new PermissionDeniedError(lockedMessage(request.name));
    }

    const preview = toPreview(request);
    let result: ApprovalDecision;
    if (this.#promptHandler) {
      result = await this.#promptHandler(preview);
    } else {
      printPreview(preview);
      const accepted = await confirm({
        message: `Aktion ${request.name} erlauben?`,
        default: false,
      });
      result = { accepted };
    }

    if (result.remember && this.#ruleStore && subject !== undefined) {
      await this.#ruleStore.remember({
        workspace: this.#workspace,
        tool: request.name,
        match: request.command
          ? { kind: "command-prefix", value: subject }
          : { kind: "path-glob", value: subject },
        decision: result.remember,
      });
    }

    if (!result.accepted) {
      const denials = (this.#denials.get(request.name) ?? 0) + 1;
      this.#denials.set(request.name, denials);
      const reasonSuffix = result.reason ? ` Begründung: ${result.reason}` : "";
      if (denials >= MAX_DENIALS_PER_RUN) {
        this.#lockedTools.add(request.name);
        throw new PermissionDeniedError(`${lockedMessage(request.name)}${reasonSuffix}`);
      }
      throw new PermissionDeniedError(
        `${request.name} wurde vom Benutzer abgelehnt (${denials} von ${MAX_DENIALS_PER_RUN} Ablehnungen in diesem Lauf).${reasonSuffix}`,
      );
    }
  }

  #decide(request: ApprovalRequest): Decision {
    if (request.risk === "read") {
      return request.alwaysAsk ? "ask" : "allow";
    }
    if (request.risk === "secret-read" || request.risk === "remote-shell") {
      // Neither can be "blocked" by read-only in a meaningful way (a read
      // cannot be undone by refusing it after the fact; a remote command has
      // no local sandbox to contain it either way), but neither may slip
      // through silently — both always ask, and only `allow-all` skips it.
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

/**
 * Rule-matching subject: derived from `command` for shell risk, `path`
 * otherwise, with `host` folded in ahead of it for `remote-shell` requests —
 * a rule remembered while targeting `vps` must never match the same command
 * against `produktion`.
 */
function subjectOf(request: ApprovalRequest): string | undefined {
  const base = request.command ? deriveCommandSubject(request.command) : request.path;
  if (base === undefined) {
    return undefined;
  }
  return request.host ? `${request.host}: ${base}` : base;
}

function lockedMessage(name: string): string {
  return `${name} wurde in diesem Lauf ${MAX_DENIALS_PER_RUN}-mal abgelehnt und ist bis zum Ende des Laufs gesperrt. Formuliere die Aufgabe neu oder starte einen neuen Lauf.`;
}

/**
 * Map an internal request onto the UI-facing preview. The risk level is passed
 * through unchanged; only the policy hints become readable text.
 */
function toPreview(request: ApprovalRequest): ToolCallPreview {
  const notes: string[] = [];
  if (request.risk === "secret-read") {
    notes.push(
      "Vertraulicher Pfad: der Inhalt würde als Klartext an das Modell gesendet.",
    );
  }
  if (request.risk === "remote-shell" && request.host) {
    // Structural, not just phrasing in the caller's summary: whatever
    // ssh_command writes as its summary, the host still gets its own,
    // impossible-to-miss line — this is the one piece of chrome that must
    // never depend on someone remembering to word the summary well.
    notes.push(`SSH-ZIEL (NICHT LOKAL): ${request.host.toUpperCase()}`);
  }
  if (request.alwaysAsk) {
    notes.push(
      `Geschützter Pfad${request.policyRule ? ` (${request.policyRule})` : ""}: Freigabe ist in jedem Modus nötig.`,
    );
  }
  const details = [...notes, request.details].filter(Boolean).join("\n");
  return {
    name: request.name,
    risk: request.risk,
    summary: request.summary,
    ...(details ? { details } : {}),
  };
}

export function approvalRiskLabel(risk: ApprovalRisk): string {
  switch (risk) {
    case "shell":
      return "SHELL";
    case "remote-shell":
      return "SSH";
    case "edit":
      return "EDIT";
    case "secret-read":
      return "GEHEIMNIS";
    case "read":
      return "READ";
    default:
      // A risk level added later must never surface as "undefined" in an
      // approval header. Unknown means unclassified, which is the cautious
      // reading, not the harmless one.
      return "UNBEKANNT";
  }
}

export function approvalDescription(mode: ApprovalMode): string {
  switch (mode) {
    case "read-only":
      return "Nur lesen; Änderungen und Shell-Befehle werden blockiert. Lesezugriff auf Geheimnisse fragt nach.";
    case "ask":
      return "Vor Dateiänderungen und jedem Shell-Befehl fragen.";
    case "auto-edit":
      return "Dateiänderungen automatisch, vor Shell-Befehlen fragen. Geschützte Pfade fragen trotzdem nach.";
    case "allow-all":
      return "Dateiänderungen und Shell-Befehle ohne Nachfrage. Gefährlich. Nur geschützte Pfade fragen weiter nach.";
  }
}

function printPreview(preview: ToolCallPreview): void {
  const risk = riskLabel(preview.risk);
  console.log(`\n${chalk.yellow("Freigabe erforderlich")} ${risk}`);
  console.log(chalk.bold(stripControlCharacters(preview.summary)));
  if (preview.details) {
    console.log(chalk.dim(stripControlCharacters(truncate(preview.details, 5_000))));
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

function riskLabel(risk: ToolRisk): string {
  if (risk === "remote-shell") {
    // Its own, more emphatic look than local `shell` — a glance must be
    // enough to tell "this leaves the machine" apart from "this doesn't".
    return chalk.bgRed.white.bold(" SSH ");
  }
  if (risk === "shell") {
    return chalk.red("[SHELL]");
  }
  if (risk === "edit") {
    return chalk.yellow("[EDIT]");
  }
  if (risk === "secret-read") {
    return chalk.magenta("[GEHEIMNIS]");
  }
  return chalk.green("[READ]");
}
