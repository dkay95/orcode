import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type { ApprovalMode, ToolCallPreview, ToolRisk } from "./types.js";
import { truncate } from "./utils.js";

export class PermissionDeniedError extends Error {}

export type ApprovalPromptHandler = (
  preview: ToolCallPreview,
) => Promise<boolean>;

export class ApprovalManager {
  #mode: ApprovalMode;
  #promptHandler: ApprovalPromptHandler | undefined;

  constructor(mode: ApprovalMode) {
    this.#mode = mode;
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

  async authorize(preview: ToolCallPreview): Promise<void> {
    if (preview.risk === "read") {
      return;
    }
    if (this.#mode === "read-only") {
      throw new PermissionDeniedError(
        `${preview.name} wurde im read-only-Modus blockiert.`,
      );
    }
    if (this.#mode === "allow-all") {
      return;
    }
    if (this.#mode === "auto-edit" && preview.risk === "edit") {
      return;
    }

    let accepted: boolean;
    if (this.#promptHandler) {
      accepted = await this.#promptHandler(preview);
    } else {
      printPreview(preview);
      accepted = await confirm({
        message: `Aktion ${preview.name} erlauben?`,
        default: false,
      });
    }
    if (!accepted) {
      throw new PermissionDeniedError(`${preview.name} wurde vom Benutzer abgelehnt.`);
    }
  }
}

export function approvalDescription(mode: ApprovalMode): string {
  switch (mode) {
    case "read-only":
      return "Nur lesen; Änderungen und Shell-Befehle werden blockiert.";
    case "ask":
      return "Vor Dateiänderungen und jedem Shell-Befehl fragen.";
    case "auto-edit":
      return "Dateiänderungen automatisch, vor Shell-Befehlen fragen.";
    case "allow-all":
      return "Dateiänderungen und Shell-Befehle ohne Nachfrage. Gefährlich.";
  }
}

export function shouldWarnForMode(mode: ApprovalMode): boolean {
  return mode === "allow-all";
}

function printPreview(preview: ToolCallPreview): void {
  const risk = riskLabel(preview.risk);
  console.log(`\n${chalk.yellow("Freigabe erforderlich")} ${risk}`);
  console.log(chalk.bold(preview.summary));
  if (preview.details) {
    console.log(chalk.dim(truncate(preview.details, 5_000)));
  }
}

function riskLabel(risk: ToolRisk): string {
  if (risk === "shell") {
    return chalk.red("[SHELL]");
  }
  if (risk === "edit") {
    return chalk.yellow("[EDIT]");
  }
  return chalk.green("[READ]");
}
