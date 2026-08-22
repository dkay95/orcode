/** Exact, versioned remembered approval rules. */

import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { PrivateStore } from "./private-store.js";
import type { ApprovalEffect, ApprovalSubject } from "./types.js";
import { hasCode } from "./utils.js";

export const RULES_APP_HOME = join(homedir(), ".orcode");
const RULE_FILE_VERSION = 2 as const;
const SUBJECT_FINGERPRINT_DOMAIN = "orcode:approval-subject:v1\0";

export function rulesPath(appHome: string = RULES_APP_HOME): string {
  return join(appHome, "permissions.json");
}

export interface ExactSubjectMatch {
  kind: "exact-subject";
  fingerprint: string;
  display: string;
}

export interface DisabledRuleMatch {
  kind: "disabled";
  reason: string;
  legacy?: { kind: string; value?: string };
}

export type RuleMatch = ExactSubjectMatch | DisabledRuleMatch;

export interface PermissionRule {
  id: string;
  workspace: string;
  tool: string;
  match: RuleMatch;
  decision: "allow" | "deny";
  createdAt: string;
}

export interface RuleFileV2 {
  version: typeof RULE_FILE_VERSION;
  rules: PermissionRule[];
}

interface LegacyRule {
  id: string;
  workspace: string;
  tool: string;
  match: { kind: "command-prefix" | "path-glob" | "any"; value?: string };
  decision: "allow" | "deny";
  createdAt: string;
}

export interface ShellSubjectInput {
  platform: string;
  executable: string;
  mode: readonly string[];
  cwd: string;
  command: string;
}

/** CRLF is transport noise; every other command byte remains authoritative. */
export function shellApprovalSubject(input: ShellSubjectInput): Extract<ApprovalSubject, { kind: "shell-string" }> {
  return {
    kind: "shell-string",
    platform: input.platform,
    executable: input.executable,
    mode: [...input.mode],
    cwd: input.cwd,
    command: input.command.replaceAll("\r\n", "\n"),
  };
}

export interface ProcessSubjectInput {
  executable: string;
  argv: readonly string[];
  cwd: string;
  forwardedEnvironment: NodeJS.ProcessEnv | readonly string[];
}

/** Persist names only; values never cross the rule-store boundary. */
export function processApprovalSubject(input: ProcessSubjectInput): Extract<ApprovalSubject, { kind: "structured-process" }> {
  const names = Array.isArray(input.forwardedEnvironment)
    ? input.forwardedEnvironment
    : Object.entries(input.forwardedEnvironment)
        .filter(([, value]) => value !== undefined)
        .map(([name]) => name);
  return {
    kind: "structured-process",
    executable: input.executable,
    argv: [...input.argv],
    cwd: input.cwd,
    environment: [...new Set(names)].sort(),
  };
}

/** Resolve symlinks before expressing cwd relative to the canonical workspace. */
export async function canonicalWorkspaceRelativeCwd(workspace: string, cwd: string): Promise<string> {
  const [canonicalWorkspace, canonicalCwd] = await Promise.all([realpath(workspace), realpath(cwd)]);
  const value = relative(canonicalWorkspace, canonicalCwd);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`Arbeitsverzeichnis liegt außerhalb des kanonischen Workspace: ${cwd}`);
  }
  return value ? value.split(sep).join("/") : ".";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const EFFECTS = new Set<ApprovalEffect>(["read", "write", "process", "network", "remote", "git-history"]);

/** Canonicalize arrays and CRLF, or reject a subject that cannot be safely persisted. */
export function normalizeApprovalSubject(subject: ApprovalSubject): ApprovalSubject | null {
  switch (subject.kind) {
    case "selected-path":
      return nonEmpty(subject.path) ? { kind: subject.kind, path: subject.path } : null;
    case "selected-path-glob":
      return nonEmpty(subject.base) && nonEmpty(subject.pattern)
        ? { kind: subject.kind, base: subject.base, pattern: subject.pattern }
        : null;
    case "shell-string":
      return nonEmpty(subject.platform) && nonEmpty(subject.executable) && nonEmpty(subject.cwd) && nonEmpty(subject.command)
        && Array.isArray(subject.mode) && subject.mode.every((item) => typeof item === "string")
        ? shellApprovalSubject(subject)
        : null;
    case "structured-process":
      return nonEmpty(subject.executable) && nonEmpty(subject.cwd)
        && Array.isArray(subject.argv) && subject.argv.every((item) => typeof item === "string")
        && Array.isArray(subject.environment) && subject.environment.every(nonEmpty)
        ? {
            kind: subject.kind,
            executable: subject.executable,
            argv: [...subject.argv],
            cwd: subject.cwd,
            environment: [...new Set(subject.environment)].sort(),
          }
        : null;
    case "ssh-command":
      return nonEmpty(subject.host) && nonEmpty(subject.command)
        ? { kind: subject.kind, host: subject.host, command: subject.command }
        : null;
    case "url-operation":
      return nonEmpty(subject.origin) && nonEmpty(subject.operation)
        ? { kind: subject.kind, origin: subject.origin, operation: subject.operation }
        : null;
    case "mcp-tool":
      return nonEmpty(subject.server) && nonEmpty(subject.tool) && EFFECTS.has(subject.effect)
        ? { kind: subject.kind, server: subject.server, tool: subject.tool, effect: subject.effect }
        : null;
    case "git-mutation":
      return nonEmpty(subject.repository) && nonEmpty(subject.mutation)
        ? { kind: subject.kind, repository: subject.repository, mutation: subject.mutation }
        : null;
  }
}

export function approvalSubjectDisplay(subject: ApprovalSubject): string {
  const canonical = normalizeApprovalSubject(subject);
  if (!canonical) throw new Error("Freigabe-Subjekt ist nicht sicher ableitbar.");
  return JSON.stringify(canonical);
}

export function approvalSubjectFingerprint(subject: ApprovalSubject): string {
  return createHash("sha256")
    .update(SUBJECT_FINGERPRINT_DOMAIN)
    .update(approvalSubjectDisplay(subject))
    .digest("hex");
}

export function exactSubjectMatch(subject: ApprovalSubject): ExactSubjectMatch | null {
  const canonical = normalizeApprovalSubject(subject);
  if (!canonical) return null;
  return {
    kind: "exact-subject",
    fingerprint: approvalSubjectFingerprint(canonical),
    display: approvalSubjectDisplay(canonical),
  };
}

function disabledLegacy(match: LegacyRule["match"], reason: string): DisabledRuleMatch {
  return {
    kind: "disabled",
    reason,
    legacy: { kind: match.kind, ...(typeof match.value === "string" ? { value: match.value } : {}) },
  };
}

function safeLiteralLegacyPath(value: unknown): value is string {
  return nonEmpty(value)
    && !isAbsolute(value)
    && !value.startsWith("~")
    && !/(^|[\\/])\.\.([\\/]|$)/.test(value)
    && !/[*?\[\]{}!]/.test(value);
}

function migrateLegacyRule(rule: LegacyRule): PermissionRule {
  let match: RuleMatch;
  if (rule.match.kind === "path-glob" && safeLiteralLegacyPath(rule.match.value)) {
    match = exactSubjectMatch({ kind: "selected-path", path: rule.match.value })!;
  } else if (rule.match.kind === "command-prefix") {
    match = disabledLegacy(rule.match, "Legacy command-prefix war nicht exakt; Shell, Modus, cwd und vollständige Befehlsbytes fehlen.");
  } else if (rule.match.kind === "any") {
    match = disabledLegacy(rule.match, "Legacy any war zu weit gefasst und wurde sicherheitshalber deaktiviert.");
  } else {
    match = disabledLegacy(rule.match, "Legacy path-glob war mehrdeutig und wurde sicherheitshalber deaktiviert.");
  }
  return { ...rule, match };
}

function isDecision(value: unknown): value is "allow" | "deny" {
  return value === "allow" || value === "deny";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseV2Rule(value: unknown): PermissionRule | null {
  const candidate = record(value);
  const match = record(candidate?.match);
  if (!candidate || !match || !nonEmpty(candidate.id) || !nonEmpty(candidate.workspace)
    || !nonEmpty(candidate.tool) || !nonEmpty(candidate.createdAt) || !isDecision(candidate.decision)) return null;
  let parsedMatch: RuleMatch;
  if (match.kind === "exact-subject" && nonEmpty(match.fingerprint) && nonEmpty(match.display)) {
    parsedMatch = { kind: "exact-subject", fingerprint: match.fingerprint, display: match.display };
  } else if (match.kind === "disabled" && nonEmpty(match.reason)) {
    parsedMatch = { kind: "disabled", reason: match.reason };
  } else {
    parsedMatch = { kind: "disabled", reason: "Ungültiger v2-Regelsatz wurde deaktiviert." };
  }
  return {
    id: candidate.id,
    workspace: candidate.workspace,
    tool: candidate.tool,
    match: parsedMatch,
    decision: candidate.decision,
    createdAt: candidate.createdAt,
  };
}

function parseLegacyRule(value: unknown): LegacyRule | null {
  const candidate = record(value);
  const match = record(candidate?.match);
  if (!candidate || !match || !nonEmpty(candidate.id) || !nonEmpty(candidate.workspace)
    || !nonEmpty(candidate.tool) || !nonEmpty(candidate.createdAt) || !isDecision(candidate.decision)
    || (match.kind !== "command-prefix" && match.kind !== "path-glob" && match.kind !== "any")) return null;
  return {
    id: candidate.id,
    workspace: candidate.workspace,
    tool: candidate.tool,
    match: { kind: match.kind, ...(typeof match.value === "string" ? { value: match.value } : {}) },
    decision: candidate.decision,
    createdAt: candidate.createdAt,
  };
}

/** Parse current rules or safely upgrade the legacy v1 shape without persisting it. */
export function normalizePermissionRuleFile(value: unknown): RuleFileV2 {
  const parsed = record(value);
  const version = parsed?.version;
  if (!parsed || (version !== 1 && version !== RULE_FILE_VERSION)) {
    throw new Error(`Unbekannte Berechtigungsregel-Version ${String(version)}.`);
  }
  const values = Array.isArray(parsed.rules) ? parsed.rules : [];
  const rules = version === RULE_FILE_VERSION
    ? values.map(parseV2Rule).filter((rule): rule is PermissionRule => rule !== null)
    : values.map(parseLegacyRule).filter((rule): rule is LegacyRule => rule !== null).map(migrateLegacyRule);
  return { version: RULE_FILE_VERSION, rules };
}

export class RuleStore {
  #appHome: string;
  #rules: PermissionRule[];
  readonly #privateStore: PrivateStore;

  private constructor(appHome: string, rules: PermissionRule[]) {
    this.#appHome = appHome;
    this.#rules = rules;
    this.#privateStore = new PrivateStore();
  }

  static async load(appHome: string = RULES_APP_HOME): Promise<RuleStore> {
    try {
      const raw = JSON.parse(await readFile(rulesPath(appHome), "utf8"));
      const parsed = normalizePermissionRuleFile(raw);
      const store = new RuleStore(appHome, parsed.rules);
      if (record(raw)?.version === 1) await store.#persist();
      return store;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return new RuleStore(appHome, []);
      throw error;
    }
  }

  decide(workspace: string, tool: string, subject: ApprovalSubject): "allow" | "deny" | null {
    const match = exactSubjectMatch(subject);
    if (!match) return null;
    let allowed = false;
    for (const rule of this.#rules) {
      if (rule.workspace !== workspace || rule.tool !== tool || rule.match.kind !== "exact-subject"
        || rule.match.fingerprint !== match.fingerprint) continue;
      if (rule.decision === "deny") return "deny";
      allowed = true;
    }
    return allowed ? "allow" : null;
  }

  async remember(rule: {
    workspace: string;
    tool: string;
    subject: ApprovalSubject;
    decision: "allow" | "deny";
  }): Promise<PermissionRule> {
    const match = exactSubjectMatch(rule.subject);
    if (!match) throw new Error("Freigabe kann ohne sicheres exaktes Subjekt nicht gespeichert werden.");
    const created: PermissionRule = {
      id: randomUUID(), workspace: rule.workspace, tool: rule.tool, match,
      decision: rule.decision, createdAt: new Date().toISOString(),
    };
    this.#rules.push(created);
    await this.#persist();
    return created;
  }

  async forget(id: string): Promise<boolean> {
    const before = this.#rules.length;
    this.#rules = this.#rules.filter((rule) => rule.id !== id);
    if (this.#rules.length === before) return false;
    await this.#persist();
    return true;
  }

  list(workspace: string): PermissionRule[] {
    return this.#rules.filter((rule) => rule.workspace === workspace);
  }

  async #persist(): Promise<void> {
    const file: RuleFileV2 = { version: RULE_FILE_VERSION, rules: this.#rules };
    await this.#privateStore.writeTextAtomic(
      rulesPath(this.#appHome),
      `${JSON.stringify(file, null, 2)}\n`,
    );
  }
}
