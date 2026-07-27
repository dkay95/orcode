import { confirm, password, search } from "@inquirer/prompts";
import { readFile, writeFile } from "node:fs/promises";
import chalk from "chalk";
import {
  SpendUnavailableError,
  assertSpendAvailable,
  type OrcodeAgent,
} from "./agent.js";
import { SLASH_COMMANDS } from "./command-catalog.js";
import {
  APPROVAL_MODES,
  COMPRESSION_MODES,
  REASONING_EFFORTS,
  type BalanceInfo,
  type CreditInfo,
  type ModelInfo,
  type ReasoningEffort,
  type ReasoningSetting,
  type OrcodeConfig,
} from "./types.js";
import {
  CONFIG_PATH,
  DATA_COLLECTIONS,
  PROVIDER_SORTS,
  VERIFY_MAX_ROUNDS,
  VERIFY_MODES,
  WEB_MODES,
  isApprovalMode,
  isBudgetAction,
  isCompressionMode,
  saveConfig,
  validatePanelModelSelection,
  validateProvider,
  validateVerify,
  type BudgetConfig,
  type DataCollectionPreference,
  type ProviderSortPreference,
  type OrcodeConfigWithBudget,
  type VerifyMode,
  type WebMode,
} from "./config.js";
import { approvalDescription, ApprovalManager } from "./approval.js";
import { RuleStore } from "./rules.js";
import { loadSshHosts } from "./ssh-config.js";
import { checkHost, closeSshControl, createSshSession, type RunSsh, type SshSession } from "./ssh.js";
import type { CredentialStoreLike } from "./credentials.js";
import {
  OpenRouterHttpError,
  OpenRouterService,
  createPanelCall,
  estimatePanelModelCostUsd,
  modelCapabilities,
  proposePanelModels,
  type BalanceReport,
  type KeyOrigin,
} from "./openrouter.js";
import {
  PANEL_MIN_MODELS,
  askPanel,
  estimatePanelCost,
  synthesize,
  type PanelCall,
  type PanelJudgment,
  type PanelResult,
} from "./panel.js";
import { renderPanel } from "./ui/panel-view.js";
import { renderLines } from "./ui/compose.js";
import { createTheme } from "./ui/theme.js";
import {
  buildResumePrompt,
  findInterruptedRun,
  formatInterruptedRunNotice,
  formatUndoOutcome,
  markRunReviewed,
  summarizeRun,
  undoInterruptedRun,
} from "./resume.js";
import { rankChatMatches, SessionStore, workspaceSpend } from "./session.js";
import { getGitDiff, runProcess, writeApprovalRequest } from "./workspace.js";
import {
  getReasoningSetting,
  reasoningLabel,
  setReasoningSetting,
  validateReasoningSetting,
} from "./reasoning.js";
import { suggestVerifyCommands } from "./verify.js";
import { errorMessage, hasCode, truncate } from "./utils.js";

/** Sink for command output — replaces the direct `console.log`/`console.error` calls. */
export interface CommandOutput {
  text(value: string): void;
  error(value: string, hint?: string): void;
}

export interface CommandContext {
  config: OrcodeConfigWithBudget;
  approvals: ApprovalManager;
  openRouter: OpenRouterService;
  session: SessionStore;
  agent: OrcodeAgent;
  workspace: string;
  credentials: CredentialStoreLike;
  out: CommandOutput;
  ruleStore: RuleStore;
  /**
   * Where `/model`, `/approval`, `/budget`, `/verify`, `/web`, `/provider`,
   * `/fallback`, … persist `config`. Defaults to the real
   * `~/.orcode/config.json` (`saveConfig`'s own default) when unset —
   * tests MUST set this to a tmp path, or every config-mutating command in
   * this file writes straight into the real user config.
   */
  configPath?: string;
  /**
   * `/ssh`'s remembered target: which host alias `ssh_command` should be
   * used against. Optional so existing fixtures/tests that never touch SSH
   * stay valid; `sshCommand` below creates one on first use if it is unset.
   */
  sshSession?: SshSession;
  /**
   * Test-only seam for `/ssh`, mirroring `configPath` above: unset means the
   * real `~/.ssh/config`. Tests MUST set this to a tmp path — `/ssh` must
   * never read the real file.
   */
  sshConfigPath?: string;
  /**
   * Test-only seam for `/ssh`: unset means the real `ssh` binary via
   * `runProcess`. Tests MUST set this instead of ever spawning a real `ssh`.
   */
  sshRunner?: RunSsh;
  /**
   * Test-only seam for `/ssh`: where the `ControlMaster` socket directory
   * lives. Unset means the real `~/.orcode/ssh` (`checkHost`'s/
   * `closeSshControl`'s own default) — tests MUST set this to a tmp path,
   * since `checkHost` creates this directory as a side effect even with a
   * fake `sshRunner`.
   */
  sshAppHome?: string;
  /**
   * `/panel`'s last result in this session, so `/panel show <n>` can expand
   * one answer without re-running the (paid) panel call. Optional — a
   * session that never ran `/panel` simply never sets it.
   */
  lastPanelResult?: PanelResult;
  /** The judge's synthesis for `lastPanelResult`, if `/panel judge` was on for that run. `null` when it ran but produced nothing usable. */
  lastPanelJudgment?: PanelJudgment | null;
  /**
   * Injectable `PanelCall` for `/panel` — defaults to the real
   * `createPanelCall(context.openRouter)`. Tests MUST override this; it is
   * the only seam between `/panel` and an actual network call.
   */
  panelCall?: PanelCall;
  /**
   * Hook back to the active input surface: seeds the *next* message the user
   * sends without sending anything automatically — visible and editable in
   * the fullscreen TUI (wired to `ui.insertInputText`), prepended silently in
   * the plain loop (wired to its own pending-seed variable), exactly like
   * cli.ts's interrupted-run "Fortsetzen" choice already does at startup.
   * `/resume fortsetzen` and `/panel use <n>` both go through this one seam.
   * Unset in `-p`/`--json` and in every test that does not exercise either.
   */
  seedNextMessage?: (text: string) => void;
  /**
   * When set, `/panel`'s result is handed to this callback instead of being
   * rendered as plain lines via `out.text` — the fullscreen TUI uses this to
   * push a proper `"panel"` block onto the chat stream (see `src/ui/blocks.ts`)
   * instead of flattening the result into a generic notice block. Unset in
   * the plain loop and in every test that does not exercise it, where the
   * existing text rendering is preserved exactly.
   */
  onPanelResult?: (
    result: PanelResult,
    judgment: PanelJudgment | null,
    expandedIndex: number | null,
  ) => void;
}

/** Every command that persists `context.config` goes through this, never a bare `saveConfig(context.config)` — see `CommandContext.configPath`. */
function saveContextConfig(context: CommandContext): Promise<void> {
  return saveConfig(context.config, context.configPath);
}

/** Writes straight to stdout/stderr — the `--plain` and non-TTY sink. */
export function createPlainCommandOutput(): CommandOutput {
  return {
    text(value: string): void {
      console.log(value);
    },
    error(value: string, hint?: string): void {
      console.error(chalk.red(value));
      if (hint) {
        console.error(chalk.dim(hint));
      }
    },
  };
}

export async function handleSlashCommand(
  raw: string,
  context: CommandContext,
): Promise<"continue" | "exit"> {
  const [commandToken = "", ...args] = tokenize(raw.slice(1));
  const command = commandToken.toLowerCase();

  switch (command) {
    case "":
    case "help":
    case "?":
      printHelp(context.out);
      return "continue";
    case "quit":
    case "exit":
    case "q":
      return "exit";
    case "status":
      printStatus(context);
      return "continue";
    case "key":
      await keyCommand(args, context);
      return "continue";
    case "balance":
    case "credits":
      await printBalance(await context.openRouter.checkBalance(), context.out);
      return "continue";
    case "reconnect": {
      const report = await context.openRouter.reconnect();
      await printBalance(report, context.out);
      for (const step of report.steps) {
        context.out.text(chalk.dim(`· ${step}`));
      }
      context.out.text(chalk.green("OpenRouter-Verbindung ist wieder erreichbar."));
      return "continue";
    }
    case "model":
      await modelCommand(args, context);
      return "continue";
    case "models":
      await modelsCommand(args, context);
      return "continue";
    case "think":
    case "reasoning":
      await reasoningCommand(args, context);
      return "continue";
    case "approval":
    case "allow":
    case "approvals":
    case "permissions":
      await approvalCommand(args, context);
      return "continue";
    case "chat":
    case "chats":
    case "switch":
      await chatCommand(args, context);
      return "continue";
    case "new":
      await chatCommand(["new", ...args], context);
      return "continue";
    case "fork":
      await chatCommand(["fork", ...args], context);
      return "continue";
    case "compress":
    case "compressor":
      await compressorCommand(args, context);
      return "continue";
    case "image":
    case "attach":
      context.out.text(
        "Bildanhänge sind in der Fullscreen-TUI verfügbar: /image oder /image <pfad>",
      );
      return "continue";
    case "whisper":
    case "voice":
      context.out.text(
        "Spracheingabe ist in der Fullscreen-TUI verfügbar: /whisper.",
      );
      return "continue";
    case "panel":
      await panelCommand(args, context);
      return "continue";
    case "cost":
    case "costs":
      printCosts(context.session, context.out);
      return "continue";
    case "max-cost":
      await maxCostCommand(args, context);
      return "continue";
    case "steps":
      await stepsCommand(args, context);
      return "continue";
    case "history":
      printHistory(context.session, args, context.out);
      return "continue";
    case "clear":
      await clearSession(context.session, context.agent, context.out);
      return "continue";
    case "diff":
      context.out.text(await getGitDiff(context.workspace));
      return "continue";
    case "undo":
      context.out.text(
        await context.agent.journal.undoLast(context.agent.guard, context.approvals, {
          dryRun: args.includes("--dry-run"),
        }),
      );
      return "continue";
    case "resume":
      await resumeCommand(args, context);
      return "continue";
    case "config":
      context.out.text(chalk.bold(CONFIG_PATH));
      context.out.text(JSON.stringify(context.config, null, 2));
      return "continue";
    case "export":
      await exportCommand(args, context);
      return "continue";
    case "checkpoint":
    case "checkpoints":
      await checkpointCommand(args, context);
      return "continue";
    case "budget":
      await budgetCommand(args, context);
      return "continue";
    case "verify":
      await verifyCommand(args, context);
      return "continue";
    case "web":
      await webCommand(args, context);
      return "continue";
    case "provider":
      await providerCommand(args, context);
      return "continue";
    case "fallback":
    case "fallbacks":
      await fallbackCommand(args, context);
      return "continue";
    case "init":
      await initInstructions(context);
      return "continue";
    case "ssh":
      await sshCommand(args, context);
      return "continue";
    default:
      context.out.error(`Unbekannter Befehl: /${command}.`, "Nutze /help.");
      return "continue";
  }
}

export async function promptForValidKey(
  openRouter: OpenRouterService,
  credentials: CredentialStoreLike,
  out: CommandOutput,
  fallback?: {
    key: string;
    origin: Exclude<KeyOrigin, "none">;
  },
): Promise<BalanceReport> {
  let nextFallback = fallback;
  while (true) {
    if (openRouter.hasKey) {
      const origin = openRouter.keyOrigin;
      const activeKey = openRouter.requireKey();
      try {
        const balance = await openRouter.checkBalance();
        assertSpendAvailable(balance);
        if (origin !== "keychain") {
          const saved = await persistCredential(
            credentials,
            "inference",
            activeKey,
            out,
          );
          if (saved) {
            openRouter.setKey(activeKey, "keychain");
            out.text(
              chalk.green(
                `API-Key gültig und sicher im ${credentials.location} gespeichert.`,
              ),
            );
          }
        }
        return balance;
      } catch (error) {
        if (!shouldReplaceCredential(error)) {
          throw error;
        }
        const message = openRouter.safeMessage(error).replace(/[.!?]+$/, "");
        openRouter.forgetKey();
        let removedFromKeychain = false;
        if (origin === "keychain") {
          try {
            removedFromKeychain = await credentials.delete("inference");
          } catch (deleteError) {
            out.text(
              chalk.yellow(
                `Der abgelehnte Key konnte nicht aus dem Schlüsselbund entfernt werden: ${
                  deleteError instanceof Error
                    ? deleteError.message
                    : String(deleteError)
                }`,
              ),
            );
          }
        }
        if (!process.stdin.isTTY) {
          throw new Error(
            `${originLabel(origin)} wurde abgelehnt: ${message}. Setze einen gültigen Key.`,
          );
        }
        out.error(
          `${originLabel(origin)} wurde abgelehnt${
            removedFromKeychain ? " und aus dem Schlüsselbund entfernt" : ""
          }: ${message}`,
        );
        if (
          nextFallback &&
          nextFallback.key.trim() !== activeKey.trim()
        ) {
          openRouter.setKey(nextFallback.key, nextFallback.origin);
          nextFallback = undefined;
          continue;
        }
      }
    }
    if (!process.stdin.isTTY) {
      throw new Error(
        "OPENROUTER_API_KEY fehlt. Setze die Umgebungsvariable vor dem nicht-interaktiven Start.",
      );
    }
    const candidate = await password({
      message: "OpenRouter API-Key (verdeckt):",
      mask: "•",
      validate: (value) => value.trim().length >= 20 || "Der Key ist zu kurz.",
    });
    const temporary = new OpenRouterService(candidate);
    try {
      const balance = await temporary.checkBalance();
      assertSpendAvailable(balance);
      const saved = await persistCredential(
        credentials,
        "inference",
        candidate,
        out,
      );
      openRouter.setKey(candidate, saved ? "keychain" : "interactive");
      out.text(
        chalk.green(
          saved
            ? `API-Key gültig und sicher im ${credentials.location} gespeichert.`
            : "API-Key gültig. Er bleibt für diese Sitzung im Prozessspeicher.",
        ),
      );
      return balance;
    } catch (error) {
      out.error(temporary.safeMessage(error));
    }
  }
}

export async function printBalance(
  balance: Awaited<ReturnType<OpenRouterService["checkBalance"]>>,
  out: CommandOutput,
): Promise<void> {
  out.text(chalk.bold("OpenRouter-Status"));
  out.text(`Key gültig: ${chalk.green("ja")}`);
  out.text(`Tarif: ${balance.key.isFreeTier ? "Free Tier" : "bezahlt/individuell"}`);
  if (balance.key.limit !== null && balance.key.limit !== undefined) {
    out.text(
      `Key-Limit: ${usd(balance.key.limit)} · verbleibend ${usd(balance.key.limitRemaining ?? 0)}`,
    );
  } else {
    out.text(`Key-Nutzung: ${usd(balance.key.usage ?? 0)} · kein eigenes Key-Limit`);
  }
  if (balance.credits) {
    out.text(
      `Kontoguthaben: ${usd(balance.credits.remaining)} verbleibend · ${usd(balance.credits.totalUsage)} genutzt`,
    );
  } else if (balance.capabilities?.creditsSource === "none") {
    // No failed request happened here — the round was skipped on purpose.
    out.text(
      chalk.yellow(
        `Kontoguthaben unbekannt: ${balance.creditsUnavailableReason ?? balance.capabilities.summary}`,
      ),
    );
  } else if (balance.creditsUnavailableReason) {
    out.text(chalk.yellow(balance.creditsUnavailableReason));
  }
  if (balance.capabilities) {
    out.text(chalk.dim(`Key-Fähigkeiten: ${balance.capabilities.summary}`));
  }
  if (balance.key.expiresAt) {
    out.text(`Key läuft ab: ${balance.key.expiresAt}`);
  }
}

function printHelp(out: CommandOutput): void {
  out.text(`\n${chalk.bold("orcode Befehle")}`);
  const width = Math.max(...SLASH_COMMANDS.map((command) => command.usage.length));
  for (const command of SLASH_COMMANDS) {
    out.text(`  ${command.usage.padEnd(width)}  ${command.description}`);
  }
  out.text("");
}

function printStatus(context: CommandContext): void {
  context.out.text(chalk.bold("orcode Status"));
  context.out.text(`Workspace: ${context.workspace}`);
  context.out.text(`Main-Modell: ${context.config.mainModel}`);
  context.out.text(
    `Thinking: ${reasoningLabel(getReasoningSetting(context.config))}`,
  );
  context.out.text(
    `Kompressor: ${context.config.compressionMode} · ${context.config.compressorModel} · Schwelle ${context.config.compressionThresholdChars} Zeichen`,
  );
  context.out.text(
    `Approval: ${context.approvals.mode} · ${approvalDescription(context.approvals.mode)}`,
  );
  context.out.text(
    `Grenzen: ${context.config.maxSteps} Tool-Schritte · ${usd(context.config.maxCostUsd)} Main · ${usd(context.config.compressorMaxCostUsd)} Kompressor`,
  );
  context.out.text(chalk.dim(compressorLimitNote(context.config.compressorModel)));
  context.out.text(`Budget: ${budgetSummary(context.config.budget)}`);
  context.out.text(
    `API-Key: ${keyStatusLabel(context.openRouter.keyOrigin, context.credentials.location)}`,
  );
  context.out.text(
    `Management-Key: ${keyStatusLabel(context.openRouter.managementKeyOrigin, context.credentials.location)}`,
  );
  printCosts(context.session, context.out);
}

/**
 * The compressor limit is enforced before the call — but only when a price for
 * the model is known. A dynamic route has no price, so the limit can only be
 * checked afterwards; saying otherwise would be a promise we cannot keep.
 */
function compressorLimitNote(compressorModel: string): string {
  return compressorModel.startsWith("openrouter/")
    ? `Für ${compressorModel} liegt kein fester Preis vor: das Kompressorlimit kann erst nach dem Aufruf kontrolliert werden.`
    : "Das Kompressorlimit wird vor dem Aufruf geprüft, sofern OpenRouter einen Preis für das Modell meldet.";
}

function budgetSummary(budget: BudgetConfig): string {
  const parts = [
    budget.dailyLimitUsd === null
      ? "kein Tageslimit"
      : `Tag ${usd(budget.dailyLimitUsd)}`,
    budget.totalLimitUsd === null
      ? "kein Gesamtlimit"
      : `Gesamt ${usd(budget.totalLimitUsd)}`,
  ];
  const action = budget.onExceed === "block" ? "blockiert" : "warnt";
  return `${parts.join(" · ")} · bei Überschreitung ${action}`;
}

async function keyCommand(args: string[], context: CommandContext): Promise<void> {
  const action = (args[0] ?? "status").toLowerCase();
  if (action === "status") {
    const stored = await context.credentials.has("inference");
    context.out.text(`Aktiver API-Key: ${keyStatusLabel(context.openRouter.keyOrigin, context.credentials.location)}`);
    context.out.text(
      `Gespeicherter API-Key: ${
        stored ? `ja, im ${context.credentials.location}` : "nein"
      }`,
    );
    if (context.openRouter.hasKey) {
      await printBalance(await context.openRouter.checkBalance(), context.out);
    }
    return;
  }
  if (action === "forget") {
    const removed = await context.credentials.delete("inference");
    context.openRouter.forgetKey();
    context.out.text(
      removed
        ? `API-Key aus Prozessspeicher und ${context.credentials.location} entfernt.`
        : "API-Key aus dem Prozessspeicher entfernt; im Schlüsselbund war keiner gespeichert.",
    );
    return;
  }
  if (action === "set") {
    const candidate = await password({
      message: "Neuer OpenRouter API-Key (verdeckt):",
      mask: "•",
      validate: (value) => value.trim().length >= 20 || "Der Key ist zu kurz.",
    });
    const balance = await validateAndStoreInferenceKey(candidate, context);
    context.out.text(
      chalk.green(
        `Neuer Key ist gültig und im ${context.credentials.location} gespeichert.`,
      ),
    );
    await printBalance(balance, context.out);
    return;
  }
  if (action === "management") {
    const managementAction = (args[1] ?? "status").toLowerCase();
    if (managementAction === "status") {
      const stored = await context.credentials.has("management");
      context.out.text(
        context.openRouter.hasManagementKey
          ? `Management-Key aktiv: ${keyStatusLabel(context.openRouter.managementKeyOrigin, context.credentials.location)}.`
          : "Kein Management-Key aktiv; /balance prüft nur das Limit des Inference-Keys.",
      );
      context.out.text(
        `Gespeicherter Management-Key: ${
          stored ? `ja, im ${context.credentials.location}` : "nein"
        }`,
      );
      return;
    }
    if (managementAction === "forget") {
      await context.credentials.delete("management");
      context.openRouter.forgetManagementKey();
      context.out.text(
        `Management-Key aus Prozessspeicher und ${context.credentials.location} entfernt.`,
      );
      return;
    }
    if (managementAction === "set") {
      const candidate = await password({
        message: "OpenRouter Management-Key für /credits (verdeckt):",
        mask: "•",
        validate: (value) => value.trim().length >= 20 || "Der Key ist zu kurz.",
      });
      const credits = await validateAndStoreManagementKey(candidate, context);
      context.out.text(
        chalk.green(
          `Management-Key gültig und im ${context.credentials.location} gespeichert. Kontoguthaben: ${usd(credits.remaining)} verbleibend.`,
        ),
      );
      return;
    }
    context.out.text("Verwendung: /key management set | status | forget");
    return;
  }
  context.out.text(
    "Verwendung: /key set | status | forget | /key management set | status | forget",
  );
}

export async function validateAndStoreInferenceKey(
  candidate: string,
  context: Pick<CommandContext, "credentials" | "openRouter">,
  signal?: AbortSignal,
): Promise<BalanceReport> {
  const temporary = new OpenRouterService(candidate);
  const balance = await temporary.checkBalance(signal);
  assertSpendAvailable(balance);
  await context.credentials.set("inference", candidate);
  context.openRouter.setKey(candidate, "keychain");
  return balance;
}

export async function validateAndStoreManagementKey(
  candidate: string,
  context: Pick<CommandContext, "credentials" | "openRouter">,
  signal?: AbortSignal,
): Promise<CreditInfo> {
  const credits = await context.openRouter.validateManagementKey(candidate, signal);
  await context.credentials.set("management", candidate);
  context.openRouter.setManagementKey(candidate, "keychain");
  return credits;
}

async function modelCommand(args: string[], context: CommandContext): Promise<void> {
  const id = args.join(" ").trim();
  if (!id) {
    const models = await context.openRouter.listModels("", true);
    const selected = await pickModel(models, context.config.mainModel);
    await selectModel(selected, context);
    return;
  }
  if (id.toLowerCase() === "current") {
    const models = await context.openRouter.listModels(context.config.mainModel, true);
    const current = models.find((model) => model.id === context.config.mainModel);
    if (current) {
      printModelDetails(current, false, context.out);
    } else {
      context.out.text(`Aktive Modellroute: ${context.config.mainModel}`);
    }
    return;
  }
  if (id !== "openrouter/auto") {
    const matches = await context.openRouter.listModels(id, true);
    const exact = matches.find((model) => model.id === id);
    if (!exact) {
      throw new Error(`Kein tool-fähiges Modell mit exakter ID gefunden: ${id}`);
    }
    await selectModel(exact, context);
    return;
  }
  const matches = await context.openRouter.listModels(id, true);
  const exact = matches.find((model) => model.id === id);
  if (exact) {
    await selectModel(exact, context);
  } else {
    context.config.mainModel = id;
    context.session.setPreferences(
      context.config.mainModel,
      getReasoningSetting(context.config),
    );
    await Promise.all([saveContextConfig(context), context.session.save()]);
    context.out.text(chalk.green(`Main-Modell: ${id}`));
  }
}

async function modelsCommand(args: string[], context: CommandContext): Promise<void> {
  const query = args.join(" ");
  const models = await context.openRouter.listModels(query, true);
  if (!models.length) {
    context.out.text("Keine passenden tool-fähigen Modelle gefunden.");
    return;
  }
  context.out.text(chalk.bold(`Tool-fähige Modelle${query ? ` für „${query}“` : ""}`));
  for (const model of models.slice(0, 30)) {
    context.out.text(
      `${model.id.padEnd(52)} in ${formatPricePerMillion(model.promptPrice).padStart(11)} · out ${formatPricePerMillion(model.completionPrice).padStart(11)} · ctx ${compactNumber(model.contextLength)}`,
    );
  }
  if (models.length > 30) {
    context.out.text(chalk.dim(`${models.length - 30} weitere; Suche mit /models <begriff> eingrenzen.`));
  }
}

// ---------------------------------------------------------------------------
// /resume — review, continue, discard, or undo an interrupted previous run,
// reachable at any point in the session, not only at startup. Every actual
// effect (`buildResumePrompt`, `undoInterruptedRun`, `markRunReviewed`,
// `formatInterruptedRunNotice`, `formatUndoOutcome`) comes straight from
// resume.ts — the same functions cli.ts's own startup flow
// (`checkInterruptedRunPlain`/`checkInterruptedRunTui`) uses, so there is only
// ever one way an interrupted run gets resumed, discarded, or undone.
// ---------------------------------------------------------------------------

async function resumeCommand(args: string[], context: CommandContext): Promise<void> {
  const sub = (args[0] ?? "").toLowerCase();
  const run = await findInterruptedRun(context.session.appHome, context.session.data.id);
  if (!run) {
    context.out.text("Kein abgebrochener Lauf gefunden.");
    return;
  }
  const summary = summarizeRun(run.events);

  if (!sub) {
    context.out.text(formatInterruptedRunNotice(summary, run.fileDrift));
    context.out.text(
      chalk.dim(
        "Verwendung: /resume fortsetzen (Zusammenfassung der nächsten Nachricht voranstellen) · " +
          "/resume undo (Dateiänderungen dieses Laufs zurücknehmen) · " +
          "/resume verwerfen (nicht mehr melden, nichts wird zurückgenommen)",
      ),
    );
    return;
  }

  if (sub === "undo") {
    // Mirrors the precondition `undoInterruptedRun` documents: hydrating a
    // journal that already holds this session's own, later entries would
    // make `undoLastRun`'s "last run" ambiguous (see resume.ts). At startup
    // that is guaranteed by construction; reachable mid-session as this
    // command is, it has to be checked explicitly instead.
    if (context.agent.journal.size > 0) {
      throw new Error(
        "/resume undo ist nur sicher, solange diese Sitzung noch keine eigene Dateiänderung vorgenommen hat. " +
          "Nutze /undo für den letzten eigenen Lauf, oder starte orcode neu, um den abgebrochenen Lauf zurückzunehmen.",
      );
    }
    const outcome = await undoInterruptedRun(
      context.agent.journal,
      context.agent.guard,
      context.approvals,
      run,
    );
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    context.out.text(formatUndoOutcome(outcome));
    return;
  }

  if (sub === "verwerfen") {
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    context.out.text("Verworfen. Die bisherigen Dateiänderungen dieses Laufs bleiben unverändert.");
    return;
  }

  if (sub === "fortsetzen") {
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    const prompt = buildResumePrompt(summary);
    if (context.seedNextMessage) {
      context.seedNextMessage(prompt);
      context.out.text(chalk.dim("Zusammenfassung wird der nächsten Nachricht vorangestellt."));
    } else {
      context.out.text(prompt);
    }
    return;
  }

  throw new Error("Verwendung: /resume [fortsetzen|undo|verwerfen]");
}

// ---------------------------------------------------------------------------
// /panel — model panel: ask several models the same question in parallel and
// compare the answers. Core orchestration is `askPanel`/`synthesize` in
// panel.ts; this is just the interactive shell around it (proposal, cost
// preview, confirmation, rendering).
// ---------------------------------------------------------------------------

/**
 * `/panel <frage>` reuses the main-agent per-run cost limit
 * (`config.maxCostUsd`) as the panel's own budget guard rather than adding a
 * second, separately-configured limit — one number the user already knows
 * about, applied to "this one panel call" the same way it already applies to
 * "this one agent run".
 */
async function panelCommand(args: string[], context: CommandContext): Promise<void> {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "models") {
    await panelModelsCommand(args.slice(1), context);
    return;
  }
  if (sub === "judge") {
    await panelJudgeCommand(args.slice(1), context);
    return;
  }
  if (sub === "show") {
    panelShowCommand(args.slice(1), context);
    return;
  }
  if (sub === "use") {
    panelUseCommand(args.slice(1), context);
    return;
  }
  // Anything else — including empty input — is treated as the question, the
  // same fallback `/verify` already uses for its literal-command case: a
  // small, fixed set of reserved words up front, free text after that.
  const question = args.join(" ").trim();
  if (!question) {
    printPanelStatus(context);
    return;
  }
  await panelAskCommand(question, context);
}

function printPanelStatus(context: CommandContext): void {
  const models = context.config.panelModels;
  context.out.text(
    models.length
      ? `Panel-Modelle: ${models.join(", ")}`
      : "Panel-Modelle: keine konfiguriert — /panel <frage> schlägt welche aus dem Katalog vor.",
  );
  context.out.text(`Panel-Richter: ${context.config.panelJudge ? "an" : "aus"}`);
  context.out.text(
    chalk.dim(
      "Verwendung: /panel <frage> · /panel models <a>,<b>,… · /panel judge on|off · /panel show <n> · /panel use <n>",
    ),
  );
}

async function panelModelsCommand(args: string[], context: CommandContext): Promise<void> {
  const raw = args.join(" ").trim();
  if (!raw) {
    context.out.text(
      context.config.panelModels.length
        ? `Panel-Modelle: ${context.config.panelModels.join(", ")}`
        : "Keine Panel-Modelle konfiguriert.",
    );
    return;
  }
  const candidates = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const catalog = await context.openRouter.loadModels();
  const knownIds = catalog.flatMap((entry) =>
    entry.canonicalSlug ? [entry.id, entry.canonicalSlug] : [entry.id],
  );
  const selection = validatePanelModelSelection(candidates, knownIds);
  context.config.panelModels = selection;
  await saveContextConfig(context);
  context.out.text(chalk.green(`Panel-Modelle: ${selection.join(", ")}`));
}

async function panelJudgeCommand(args: string[], context: CommandContext): Promise<void> {
  const value = (args[0] ?? "").toLowerCase();
  if (!value) {
    context.out.text(`Panel-Richter: ${context.config.panelJudge ? "an" : "aus"}`);
    return;
  }
  if (value !== "on" && value !== "off") {
    throw new Error("Verwendung: /panel judge on|off");
  }
  context.config.panelJudge = value === "on";
  await saveContextConfig(context);
  context.out.text(chalk.green(`Panel-Richter: ${context.config.panelJudge ? "an" : "aus"}`));
}

function panelShowCommand(args: string[], context: CommandContext): void {
  const last = context.lastPanelResult;
  if (!last) {
    context.out.text("Noch kein Panel-Lauf in dieser Sitzung. Starte mit /panel <frage>.");
    return;
  }
  const index = Number(args[0]);
  if (!Number.isInteger(index) || index < 1 || index > last.answers.length) {
    throw new Error(`Verwendung: /panel show <1-${last.answers.length}>`);
  }
  printPanelResult(context, last, context.lastPanelJudgment ?? null, index - 1);
}

/**
 * Hands one panel answer's text over to the normal chat as context. Seeded
 * into the next message via `context.seedNextMessage` — the exact same
 * mechanism cli.ts's interrupted-run "Fortsetzen" choice already uses
 * (`ui.insertInputText` in the fullscreen TUI, the plain loop's own
 * pending-seed variable otherwise) — never a second way of stuffing text into
 * the next turn. The answer's model is folded into the seeded text itself, so
 * the transcript later still shows where it came from.
 */
function panelUseCommand(args: string[], context: CommandContext): void {
  const last = context.lastPanelResult;
  if (!last) {
    context.out.text("Noch kein Panel-Lauf in dieser Sitzung. Starte mit /panel <frage>.");
    return;
  }
  const index = Number(args[0]);
  if (!Number.isInteger(index) || index < 1 || index > last.answers.length) {
    throw new Error(`Verwendung: /panel use <1-${last.answers.length}>`);
  }
  const answer = last.answers[index - 1]!;
  if (answer.error || !answer.text.trim()) {
    throw new Error(`Antwort ${index} (${answer.model}) hat keinen verwendbaren Text.`);
  }
  const seeded = `Antwort von ${answer.model} (Panel):\n\n${answer.text.trim()}`;
  if (context.seedNextMessage) {
    context.seedNextMessage(seeded);
    context.out.text(
      chalk.dim(`Antwort ${index} (${answer.model}) wird der nächsten Nachricht vorangestellt.`),
    );
  } else {
    context.out.text(seeded);
  }
}

async function panelAskCommand(question: string, context: CommandContext): Promise<void> {
  let models = context.config.panelModels;
  if (models.length < PANEL_MIN_MODELS) {
    const catalog = await context.openRouter.listModels("", false);
    const proposal = proposePanelModels(catalog, 3);
    if (proposal.length < PANEL_MIN_MODELS) {
      throw new Error(
        "Nicht genug unterschiedliche Modelle im Katalog für einen Panel-Vorschlag gefunden. Setze sie manuell mit /panel models <a>,<b>,…",
      );
    }
    models = proposal.map((model) => model.id);
    context.out.text(
      chalk.bold(
        `Kein Panel konfiguriert — Vorschlag aus verschiedenen Anbietern: ${models.join(", ")}`,
      ),
    );
    context.out.text(
      chalk.dim(`Dauerhaft übernehmen: /panel models ${models.join(",")}`),
    );
  }

  const catalog = await context.openRouter.loadModels();
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const promptChars = question.length;
  const estimateForModel = (model: string): number | null => {
    const info = catalogById.get(model);
    return info ? estimatePanelModelCostUsd(modelCapabilities(info), promptChars) : null;
  };
  const estimate = estimatePanelCost(models, estimateForModel);

  context.out.text(
    `${models.length} Modelle × geschätzt ≈ ${usd(estimate.totalUsd)} gesamt${
      estimate.unknownCount > 0
        ? ` (Preis für ${estimate.unknownCount} Modell(e) unbekannt, nicht eingerechnet)`
        : ""
    }.`,
  );
  for (const entry of estimate.perModelUsd) {
    context.out.text(
      `  ${entry.model.padEnd(40)} ${entry.usd === null ? "Preis unbekannt" : usd(entry.usd)}`,
    );
  }

  const proceed = await confirm({
    message: `${models.length} Modelle parallel befragen (≈ ${usd(estimate.totalUsd)})?`,
    default: false,
  });
  if (!proceed) {
    context.out.text("Panel abgebrochen.");
    return;
  }

  const callModel = context.panelCall ?? createPanelCall(context.openRouter);
  const result = await askPanel({
    question,
    models,
    callModel,
    maxCostUsd: context.config.maxCostUsd,
    estimateCostUsd: estimateForModel,
  });
  // Counted as "main" spend so it counts toward the workspace budget
  // (/budget) like every other model call — the session type has no
  // dedicated "panel" cost category, and adding one is out of scope here.
  context.session.addCost("main", result.totalCostUsd);
  context.lastPanelResult = result;

  let judgment: PanelJudgment | null = null;
  if (context.config.panelJudge) {
    try {
      judgment = await synthesize({
        question,
        answers: result.answers,
        judgeModel: context.config.mainModel,
        callModel,
      });
      context.session.addCost("main", judgment.costUsd);
    } catch (error) {
      context.out.text(chalk.yellow(`Auswertung übersprungen: ${errorMessage(error)}`));
    }
  }
  context.lastPanelJudgment = judgment;
  await context.session.save();

  printPanelResult(context, result, judgment, null);
}

function printPanelResult(
  context: CommandContext,
  result: PanelResult,
  judgment: PanelJudgment | null,
  expandedIndex: number | null,
): void {
  if (context.onPanelResult) {
    // Fullscreen TUI: render as its own block (src/ui/blocks.ts) instead of
    // flattening the result into command-output text — see src/tui.ts's
    // `addPanelResult`.
    context.onPanelResult(result, judgment, expandedIndex);
  } else {
    const theme = createTheme();
    const width = Math.max(40, Math.min(process.stdout.columns || 100, 120));
    const lines = renderPanel(result, width, theme, { expandedIndex, judgment });
    for (const line of renderLines(lines, theme)) {
      context.out.text(line);
    }
  }
  if (expandedIndex === null && result.answers.length > 0) {
    context.out.text(
      chalk.dim(`Volle Antwort ansehen: /panel show <1-${result.answers.length}>`),
    );
  }
}

async function reasoningCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const model = await findCurrentModel(context.openRouter, context.config.mainModel);
  const current = getReasoningSetting(context.config);
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    context.out.text(
      `Thinking für ${context.config.mainModel}: ${reasoningLabel(current)}`,
    );
    if (model?.reasoning?.supportedEfforts) {
      context.out.text(
        `Unterstützte Stufen: ${model.reasoning.supportedEfforts.join(", ")}`,
      );
    } else if (
      model &&
      !model.id.startsWith("openrouter/") &&
      !model.supportedParameters.includes("reasoning")
    ) {
      context.out.text("Dieses Modell meldet keine Reasoning-Unterstützung.");
    } else {
      context.out.text(`Gateway-Stufen: ${REASONING_EFFORTS.join(", ")}`);
    }
    if (model?.reasoning?.supportsMaxTokens || model?.id.startsWith("openrouter/")) {
      context.out.text("Token-Budget wird unterstützt: /think budget <Tokens>");
    }
    return;
  }

  let setting: ReasoningSetting;
  if (action === "auto") {
    setting = { mode: "auto" };
  } else if (action === "off") {
    setting = { mode: "effort", effort: "none" };
  } else if (action === "budget") {
    const maxTokens = Number(args[1]);
    if (
      !Number.isInteger(maxTokens) ||
      maxTokens < 256 ||
      maxTokens > 1_000_000
    ) {
      throw new Error(
        "Thinking-Budget muss eine ganze Zahl zwischen 256 und 1000000 Tokens sein.",
      );
    }
    setting = { mode: "budget", maxTokens };
  } else {
    const effort = normalizeReasoningEffort(action);
    if (!effort) {
      throw new Error(
        `Verwendung: /think auto|off|${REASONING_EFFORTS.filter((value) => value !== "none").join("|")} | /think budget <Tokens>`,
      );
    }
    setting = { mode: "effort", effort };
  }
  validateReasoningSetting(setting, model);
  setReasoningSetting(context.config, setting);
  context.session.setPreferences(context.config.mainModel, setting);
  await Promise.all([saveContextConfig(context), context.session.save()]);
  context.out.text(
    chalk.green(
      `Thinking für ${context.config.mainModel}: ${reasoningLabel(setting)}`,
    ),
  );
}

async function approvalCommand(args: string[], context: CommandContext): Promise<void> {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "list") {
    const rules = context.ruleStore.list(context.workspace);
    if (!rules.length) {
      context.out.text("Keine gemerkten Regeln für diesen Workspace.");
      return;
    }
    for (const rule of rules) {
      const subject =
        rule.match.kind === "any" ? "(beliebig)" : rule.match.value;
      context.out.text(
        `${rule.decision === "allow" ? chalk.green("allow") : chalk.red("deny")} ${chalk.dim(rule.tool)} ${subject} · ${rule.id.slice(0, 8)}`,
      );
    }
    return;
  }
  if (sub === "forget") {
    const target = (args[1] ?? "").toLowerCase();
    if (!target) {
      throw new Error("Verwendung: /allow forget <id>|all");
    }
    if (target === "all") {
      const rules = context.ruleStore.list(context.workspace);
      for (const rule of rules) {
        await context.ruleStore.forget(rule.id);
      }
      context.out.text(
        chalk.green(`${rules.length} Regel(n) für diesen Workspace vergessen.`),
      );
      return;
    }
    const rules = context.ruleStore.list(context.workspace);
    const match = rules.find((rule) => rule.id === target || rule.id.startsWith(target));
    if (!match) {
      context.out.text(`Keine Regel mit ID „${target}“ in diesem Workspace.`);
      return;
    }
    await context.ruleStore.forget(match.id);
    context.out.text(chalk.green(`Regel vergessen: ${match.id.slice(0, 8)}`));
    return;
  }
  const mode = sub;
  if (!mode) {
    for (const candidate of APPROVAL_MODES) {
      context.out.text(
        `${candidate === context.approvals.mode ? chalk.green("●") : "○"} ${candidate}: ${approvalDescription(candidate)}`,
      );
    }
    return;
  }
  if (!isApprovalMode(mode)) {
    throw new Error(`Ungültiger Approval-Modus. Erlaubt: ${APPROVAL_MODES.join(", ")}`);
  }
  if (mode === "allow-all") {
    const accepted = await confirm({
      message:
        "allow-all führt Dateiänderungen und Shell-Befehle ohne Nachfrage aus. Wirklich aktivieren?",
      default: false,
    });
    if (!accepted) {
      context.out.text("Approval-Modus unverändert.");
      return;
    }
  }
  context.approvals.mode = mode;
  context.config.approvalMode = mode;
  await saveContextConfig(context);
  context.out.text(chalk.green(`Approval-Modus: ${mode}`));
}

async function chatCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    const chats = await SessionStore.list(context.workspace);
    const choices = [
      {
        name: "＋ Neuer Chat",
        value: "__new__",
        description: "Leeren, getrennten Chat beginnen",
      },
      ...chats.map((chat) => ({
        name: `${chat.id === context.session.data.id ? "●" : "○"} ${chat.title}`,
        value: chat.id,
        description: `${chat.turnCount} Nachrichten · ${usd(chat.costUsd)} · ${formatChatDate(chat.updatedAt)}`,
      })),
    ];
    const selected = await search({
      message: "Chat auswählen",
      source: async (term) => {
        const query = term?.trim().toLowerCase() ?? "";
        return choices.filter((choice) =>
          `${choice.name} ${choice.description}`.toLowerCase().includes(query),
        );
      },
    });
    if (selected === "__new__") {
      await replaceSession(
        context,
        SessionStore.create(context.workspace),
      );
    } else if (selected !== context.session.data.id) {
      await replaceSession(
        context,
        await SessionStore.openById(context.workspace, selected),
      );
    }
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "list") {
    const chats = await SessionStore.list(context.workspace);
    if (!chats.length) {
      context.out.text("Noch keine gespeicherten Chats in diesem Workspace.");
      return;
    }
    for (const chat of chats) {
      const marker = chat.id === context.session.data.id ? chalk.green("●") : "○";
      context.out.text(
        `${marker} ${chat.title} · ${chat.turnCount} Nachrichten · ${usd(chat.costUsd)} · ${formatChatDate(chat.updatedAt)} · ${chat.id}`,
      );
    }
    return;
  }

  if (action === "current") {
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "new") {
    const title = args.slice(1).join(" ").trim() || "Neuer Chat";
    await replaceSession(
      context,
      SessionStore.create(context.workspace, undefined, title),
    );
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "rename") {
    const title = args.slice(1).join(" ").trim();
    if (!title) {
      throw new Error("Verwendung: /chat rename <Titel>");
    }
    context.session.rename(title);
    await context.session.save();
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "fork") {
    await saveSessionPreferences(context);
    const title = args.slice(1).join(" ").trim() ||
      `${context.session.data.title} (Fork)`;
    await replaceSession(context, await context.session.fork(title));
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "open" || action === "switch") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Verwendung: /chat open <ID oder Titel>");
    }
    const chats = await SessionStore.list(context.workspace);
    const matches = rankChatMatches(chats, query);
    if (!matches.length) {
      throw new Error(`Kein Chat gefunden: ${query}`);
    }
    const best = matches[0]!;
    const contested = matches.length > 1 && matches[1]!.score === best.score;
    if (!contested) {
      await replaceSession(
        context,
        await SessionStore.openById(context.workspace, best.chat.id),
      );
      printCurrentChat(context.session, context.out);
      return;
    }
    if (!process.stdout.isTTY) {
      throw new Error(
        `Chat-Auswahl ist nicht eindeutig: ${matches.map((match) => match.chat.title).join(", ")}`,
      );
    }
    const selected = await search({
      message: `Mehrere Chats passen zu „${query}“`,
      source: async () =>
        matches.map((match) => ({
          name: `${match.chat.id === context.session.data.id ? "●" : "○"} ${match.chat.title}`,
          value: match.chat.id,
          description: `${match.chat.turnCount} Nachrichten · ${usd(match.chat.costUsd)} · ${formatChatDate(match.chat.updatedAt)} · ${match.chat.id}`,
        })),
    });
    if (selected !== context.session.data.id) {
      await replaceSession(
        context,
        await SessionStore.openById(context.workspace, selected),
      );
    }
    printCurrentChat(context.session, context.out);
    return;
  }

  if (action === "search") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Verwendung: /chat search <Suchbegriff>");
    }
    const hits = await SessionStore.search(context.workspace, query);
    if (!hits.length) {
      context.out.text(`Keine Chats gefunden für: ${query}`);
      return;
    }
    const shown = hits.slice(0, 10);
    for (const hit of shown) {
      const marker = hit.chat.id === context.session.data.id ? chalk.green("●") : "○";
      context.out.text(
        `${marker} ${hit.chat.title} · ${hit.chat.turnCount} Nachrichten · ${usd(hit.chat.costUsd)} · ${formatChatDate(hit.chat.updatedAt)} · ${hit.chat.id}`,
      );
      if (hit.snippet) {
        context.out.text(`  ${chalk.dim(hit.snippet)}`);
      }
    }
    if (hits.length > shown.length) {
      context.out.text(chalk.dim(`… und ${hits.length - shown.length} weitere Treffer.`));
    }
    context.out.text(chalk.dim("Öffnen mit /chat open <ID oder Titel>"));
    return;
  }

  if (action === "delete" || action === "rm") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Verwendung: /chat delete <ID oder Titel>");
    }
    const chats = await SessionStore.list(context.workspace);
    const matches = rankChatMatches(chats, query);
    if (!matches.length) {
      throw new Error(`Kein Chat gefunden: ${query}`);
    }
    const best = matches[0]!;
    const contested = matches.length > 1 && matches[1]!.score === best.score;
    if (contested) {
      // Löschen ist endgültig — hier nie raten, auch nicht interaktiv.
      throw new Error(
        `Löschen abgebrochen, Auswahl nicht eindeutig: ${matches.map((match) => match.chat.title).join(", ")}`,
      );
    }
    const target = best.chat;
    const wasActive = target.id === context.session.data.id;
    await SessionStore.remove(context.workspace, target.id);
    if (wasActive) {
      // Sonst legt der nächste Auto-Save die gelöschte Datei neu an.
      await replaceSession(context, SessionStore.create(context.workspace));
    }
    context.out.text(
      `Chat endgültig gelöscht: ${target.title} (${target.id})${wasActive ? " — neuer leerer Chat gestartet." : ""}`,
    );
    return;
  }

  throw new Error(
    "Verwendung: /chat [list|new [Titel]|open <ID|Titel>|search <Begriff>|rename <Titel>|fork [Titel]|delete <ID|Titel>|current]",
  );
}

async function replaceSession(
  context: CommandContext,
  next: SessionStore,
): Promise<void> {
  if (context.session.data.id !== next.data.id) {
    await saveSessionPreferences(context);
  }
  context.session = next;
  if (next.data.model) {
    context.config.mainModel = next.data.model;
  }
  if (next.data.reasoning) {
    setReasoningSetting(context.config, next.data.reasoning);
  }
  // Swapping the chat keeps the cached model resolution, the compressor price
  // cache and the change journal; rebuilding the agent threw all of that away.
  context.agent.setSession(next);
  next.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
  );
  await Promise.all([next.save(), saveContextConfig(context)]);
}

async function saveSessionPreferences(context: CommandContext): Promise<void> {
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
  );
  await context.session.save();
}

function printCurrentChat(session: SessionStore, out: CommandOutput): void {
  out.text(
    chalk.green(
      `Chat: ${session.data.title} · ${session.data.turns.length} Nachrichten · ${session.data.id}`,
    ),
  );
}

function formatChatDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

async function compressorCommand(args: string[], context: CommandContext): Promise<void> {
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    context.out.text(
      `Kompressor: ${context.config.compressionMode} · ${context.config.compressorModel} · Schwelle ${context.config.compressionThresholdChars} Zeichen`,
    );
    return;
  }
  if (isCompressionMode(action)) {
    context.config.compressionMode = action;
  } else if (action === "model") {
    const requestedId = args.slice(1).join(" ").trim();
    if (!requestedId) {
      const models = (
        await context.openRouter.listModels("", false)
      ).filter(isTextGenerationModel);
      const selected = await pickModel(
        models,
        context.config.compressorModel,
      );
      context.config.compressorModel = selected.id;
    } else {
      const matches = await context.openRouter.listModels(requestedId, false);
      const exact = matches.find(
        (candidate) =>
          candidate.id === requestedId &&
          isTextGenerationModel(candidate),
      );
      if (!exact) {
        throw new Error(
          `Kein Textmodell mit exakter ID gefunden: ${requestedId}`,
        );
      }
      context.config.compressorModel = exact.id;
    }
  } else if (action === "threshold") {
    const threshold = Number(args[1]);
    if (!Number.isInteger(threshold) || threshold < 2_000 || threshold > 2_000_000) {
      throw new Error("Schwelle muss zwischen 2000 und 2000000 Zeichen liegen.");
    }
    context.config.compressionThresholdChars = threshold;
  } else if (action === "max-cost") {
    const value = Number(args[1]);
    if (!Number.isFinite(value) || value < 0.001 || value > 100) {
      throw new Error("Kompressor-Kostenlimit muss zwischen 0.001 und 100 USD liegen.");
    }
    context.config.compressorMaxCostUsd = value;
  } else {
    throw new Error(
      `Verwendung: /compress ${COMPRESSION_MODES.join("|")} | /compress model <id> | /compress threshold <zeichen> | /compress max-cost <USD>`,
    );
  }
  await saveContextConfig(context);
  context.out.text(
    chalk.green(
      `Kompressor: ${context.config.compressionMode} · ${context.config.compressorModel} · ${context.config.compressionThresholdChars} Zeichen`,
    ),
  );
}

async function maxCostCommand(args: string[], context: CommandContext): Promise<void> {
  if (!args[0]) {
    context.out.text(`Main-Kostenlimit pro Lauf: ${usd(context.config.maxCostUsd)}`);
    return;
  }
  const value = Number(args[0]);
  if (!Number.isFinite(value) || value < 0.001 || value > 1_000) {
    throw new Error("Kostenlimit muss zwischen 0.001 und 1000 USD liegen.");
  }
  context.config.maxCostUsd = value;
  await saveContextConfig(context);
  context.out.text(chalk.green(`Main-Kostenlimit: ${usd(value)}`));
}

async function stepsCommand(args: string[], context: CommandContext): Promise<void> {
  if (!args[0]) {
    context.out.text(`Maximale Tool-Schritte: ${context.config.maxSteps}`);
    return;
  }
  const value = Number(args[0]);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Tool-Schritte müssen zwischen 1 und 100 liegen.");
  }
  context.config.maxSteps = value;
  await saveContextConfig(context);
  context.out.text(chalk.green(`Maximale Tool-Schritte: ${value}`));
}

function printCosts(session: SessionStore, out: CommandOutput): void {
  const costs = session.data.costs;
  out.text(
    `Sitzungskosten: Main ${usd(costs.mainUsd)} · Kompressor ${usd(costs.compressorUsd)} · Transkription ${usd(costs.voiceUsd)} · Gesamt ${usd(costs.totalUsd)}`,
  );
}

function printHistory(session: SessionStore, args: string[], out: CommandOutput): void {
  const requested = Number(args[0] ?? 10);
  const count = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 50) : 10;
  const turns = session.recentTurns(count);
  if (!turns.length) {
    out.text("Kein Gesprächsverlauf.");
    return;
  }
  for (const turn of turns) {
    out.text(
      `\n${chalk.bold(turn.role === "user" ? "Du" : "orcode")} ${chalk.dim(turn.createdAt)}\n${truncate(turn.content, 2_000)}`,
    );
  }
}

async function clearSession(
  session: SessionStore,
  agent: OrcodeAgent,
  out: CommandOutput,
): Promise<void> {
  const accepted = await confirm({
    message: "Gesprächskontext und aufgezeichnete Sitzungskosten zurücksetzen?",
    default: false,
  });
  if (!accepted) {
    return;
  }
  session.clear();
  agent.resetConversationMemory();
  await session.save();
  out.text("Sitzung zurückgesetzt.");
}

async function exportCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const markdown = context.session.exportMarkdown();
  const requested = args.join(" ").trim();
  if (!requested) {
    context.out.text(markdown);
    return;
  }
  const target = await context.agent.guard.resolvePath(requested);
  const display = context.agent.guard.display(target);
  // Same policy as the write tools: `/export .git/config` must not be a way
  // around the deny list.
  await context.approvals.authorize(
    writeApprovalRequest("export", display, {
      summary: `Chat als Markdown schreiben: ${display}`,
      details: `${context.session.data.turns.length} Nachrichten · ${markdown.length} Zeichen`,
    }),
  );
  await writeFile(target, markdown, { encoding: "utf8", mode: 0o600 });
  context.out.text(chalk.green(`Chat exportiert: ${target}`));
}

async function checkpointCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const action = (args[0] ?? "list").toLowerCase();
  if (action === "list") {
    const checkpoints = context.session.listCheckpoints();
    if (!checkpoints.length) {
      context.out.text("Keine Checkpoints in diesem Chat. Anlegen mit /checkpoint new [Name].");
      return;
    }
    for (const checkpoint of checkpoints) {
      context.out.text(
        `${checkpoint.label} · nach ${checkpoint.turnIndex} Nachrichten · ${usd(checkpoint.costUsd)} · ${formatChatDate(checkpoint.createdAt)} · ${checkpoint.id.slice(0, 8)}`,
      );
    }
    return;
  }
  if (action === "new" || action === "add" || action === "create") {
    const checkpoint = context.session.createCheckpoint(
      args.slice(1).join(" ").trim(),
    );
    await context.session.save();
    context.out.text(
      chalk.green(
        `Checkpoint angelegt: ${checkpoint.label} (${checkpoint.id.slice(0, 8)})`,
      ),
    );
    return;
  }
  if (action === "restore" || action === "back") {
    const reference = args.slice(1).join(" ").trim();
    if (!reference) {
      throw new Error("Verwendung: /checkpoint restore <ID oder Name>");
    }
    const checkpoint = context.session.restoreCheckpoint(reference);
    context.agent.resetConversationMemory();
    await context.session.save();
    context.out.text(
      chalk.green(
        `Zurückgesetzt auf ${checkpoint.label}: ${context.session.data.turns.length} Nachrichten. Kosten bleiben verbucht.`,
      ),
    );
    return;
  }
  throw new Error("Verwendung: /checkpoint [list|new [Name]|restore <ID|Name>]");
}

async function budgetCommand(
  args: string[],
  context: CommandContext,
): Promise<void> {
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    // Same store the agent enforces against — not the process-wide default.
    const spend = await workspaceSpend(
      context.workspace,
      context.session.appHome,
    );
    context.out.text(`Budget: ${budgetSummary(context.config.budget)}`);
    context.out.text(
      `Verbraucht in diesem Workspace: heute ${usd(spend.dayUsd)} · gesamt ${usd(spend.totalUsd)} über ${spend.chatCount} Chat(s)`,
    );
    context.out.text(
      chalk.dim(
        "Setzen: /budget day <USD|off> · /budget total <USD|off> · /budget on-exceed warn|block",
      ),
    );
    return;
  }
  if (action === "day" || action === "total") {
    const raw = (args[1] ?? "").toLowerCase();
    const limit = raw === "off" || raw === "aus" || raw === "none"
      ? null
      : parseBudgetLimit(raw);
    if (action === "day") {
      context.config.budget.dailyLimitUsd = limit;
    } else {
      context.config.budget.totalLimitUsd = limit;
    }
  } else if (action === "on-exceed" || action === "action") {
    const value = (args[1] ?? "").toLowerCase();
    if (!isBudgetAction(value)) {
      throw new Error("Verwendung: /budget on-exceed warn|block");
    }
    context.config.budget.onExceed = value;
  } else {
    throw new Error(
      "Verwendung: /budget [day <USD|off>|total <USD|off>|on-exceed warn|block]",
    );
  }
  await saveContextConfig(context);
  context.out.text(chalk.green(`Budget: ${budgetSummary(context.config.budget)}`));
}

function parseBudgetLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.01 || value > 100_000) {
    throw new Error(
      "Budgetgrenze muss zwischen 0.01 und 100000 USD liegen, oder „off“ für kein Limit.",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// A4 — /verify. Config-only: the retry-with-model loop this drives lives in
// agent.ts and is not wired in yet (see the needsElsewhere note in the task
// report). Setting the config here is what a future agent.ts pass reads.
// ---------------------------------------------------------------------------

async function verifyCommand(args: string[], context: CommandContext): Promise<void> {
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    printVerifyStatus(context);
    return;
  }
  if (action === "on" || action === "off") {
    const mode: VerifyMode = action === "on" ? "on-edit" : "off";
    context.config.verify = validateVerify({ ...context.config.verify, mode });
    await saveContextConfig(context);
    context.out.text(chalk.green(`Verify: ${mode}`));
    return;
  }
  if (action === "now") {
    if (!context.config.verify.commands.length) {
      context.out.text(
        "Keine Verify-Kommandos konfiguriert. /verify <befehl> zum Hinzufügen.",
      );
      return;
    }
    const { runVerify } = await import("./verify.js");
    const outcome = await runVerify(
      context.config.verify.commands,
      context.agent.guard,
      undefined,
      () => {},
    );
    if (outcome.status === "passed") {
      context.out.text(chalk.green("Verify: alle Kommandos grün."));
    } else if (outcome.status === "failed") {
      context.out.error(
        `Verify fehlgeschlagen: ${outcome.command} (exit ${outcome.exitCode})`,
      );
      context.out.text(outcome.distilled);
    } else {
      context.out.text("Verify abgebrochen.");
    }
    return;
  }
  if (action === "suggest") {
    let packageJson: unknown;
    try {
      const raw = await readFile(
        await context.agent.guard.resolvePath("package.json"),
        "utf8",
      );
      packageJson = JSON.parse(raw);
    } catch {
      context.out.text("Kein lesbares package.json im Workspace gefunden.");
      return;
    }
    const suggested = suggestVerifyCommands(packageJson);
    if (!suggested.length) {
      context.out.text("Keine check/test/build-Skripte in package.json gefunden.");
      return;
    }
    context.config.verify = validateVerify({
      ...context.config.verify,
      commands: suggested,
    });
    await saveContextConfig(context);
    context.out.text(
      chalk.green(`Verify-Kommandos übernommen: ${suggested.join(", ")}`),
    );
    return;
  }
  if (action === "clear") {
    context.config.verify = validateVerify({ ...context.config.verify, commands: [] });
    await saveContextConfig(context);
    context.out.text(chalk.green("Verify-Kommandos geleert."));
    return;
  }
  if (action === "rounds") {
    const rounds = Number(args[1]);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > VERIFY_MAX_ROUNDS) {
      throw new Error(`/verify rounds muss zwischen 1 und ${VERIFY_MAX_ROUNDS} liegen.`);
    }
    context.config.verify = validateVerify({ ...context.config.verify, maxRounds: rounds });
    await saveContextConfig(context);
    context.out.text(chalk.green(`Verify-Runden: ${rounds}`));
    return;
  }
  // Anything else is treated as a literal command to add, e.g. `/verify npm run check`.
  const command = args.join(" ").trim();
  if (!command) {
    throw new Error(
      `Verwendung: /verify [on|off|now|suggest|clear|rounds <1-${VERIFY_MAX_ROUNDS}>|<befehl>]`,
    );
  }
  context.config.verify = validateVerify({
    ...context.config.verify,
    commands: [...context.config.verify.commands, command],
  });
  await saveContextConfig(context);
  context.out.text(chalk.green(`Verify-Kommando hinzugefügt: ${command}`));
}

function printVerifyStatus(context: CommandContext): void {
  const verify = context.config.verify;
  context.out.text(
    `Verify: ${verify.mode} · ${verify.maxRounds} Runde(n) · ${verify.commands.length} Kommando(s)`,
  );
  for (const command of verify.commands) {
    context.out.text(`  ${command}`);
  }
  context.out.text(
    chalk.dim(
      "Setzen: /verify on|off · /verify <befehl> · /verify suggest · /verify clear · /verify rounds <n> · /verify now",
    ),
  );
}

// ---------------------------------------------------------------------------
// A2 — /web. Config-only: `shouldEnableWebSearch`/`webSearchPlugin` from
// openrouter.ts are not yet spread into the `callModel` request (agent.ts),
// see the needsElsewhere note in the task report.
// ---------------------------------------------------------------------------

async function webCommand(args: string[], context: CommandContext): Promise<void> {
  const mode = (args[0] ?? "").toLowerCase();
  if (!mode) {
    context.out.text(`Websuche: ${context.config.web}`);
    context.out.text(chalk.dim(`Setzen: /web ${WEB_MODES.join("|")}`));
    return;
  }
  if (!includesValue(WEB_MODES, mode)) {
    throw new Error(`Ungültiger Web-Modus. Erlaubt: ${WEB_MODES.join(", ")}`);
  }
  context.config.web = mode as WebMode;
  await saveContextConfig(context);
  context.out.text(chalk.green(`Websuche: ${mode}`));
}

// ---------------------------------------------------------------------------
// A3 — /provider and /fallback. Config-only: `providerField`/`modelsField`
// from openrouter.ts are not yet spread into the `callModel` request, see the
// needsElsewhere note in the task report.
// ---------------------------------------------------------------------------

async function providerCommand(args: string[], context: CommandContext): Promise<void> {
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    printProviderStatus(context);
    return;
  }
  if (action === "sort") {
    const value = (args[1] ?? "").toLowerCase();
    if (value === "off" || value === "none") {
      const { sort: _drop, ...rest } = context.config.provider;
      context.config.provider = validateProvider(rest);
    } else if (includesValue(PROVIDER_SORTS, value)) {
      context.config.provider = validateProvider({
        ...context.config.provider,
        sort: value as ProviderSortPreference,
      });
    } else {
      throw new Error(`/provider sort erlaubt: off, ${PROVIDER_SORTS.join(", ")}`);
    }
  } else if (action === "deny" || action === "allow") {
    const dataCollection: DataCollectionPreference = action === "deny" ? "deny" : "allow";
    context.config.provider = validateProvider({
      ...context.config.provider,
      dataCollection,
    });
  } else if (action === "only" || action === "ignore") {
    const providers = args.slice(1);
    context.config.provider = validateProvider({
      ...context.config.provider,
      [action]: providers.length ? providers : undefined,
    });
  } else if (action === "clear" || action === "reset") {
    context.config.provider = validateProvider({});
  } else {
    throw new Error(
      "Verwendung: /provider [sort <off|price|throughput|latency>|allow|deny|only <a> <b>…|ignore <a> <b>…|clear]",
    );
  }
  await saveContextConfig(context);
  printProviderStatus(context);
}

function printProviderStatus(context: CommandContext): void {
  const provider = context.config.provider;
  context.out.text(
    [
      `Sortierung: ${provider.sort ?? "Standard (Preis/Verfügbarkeit)"}`,
      `Datenweitergabe: ${provider.dataCollection ?? DATA_COLLECTIONS[1]}`,
      provider.only?.length ? `Nur: ${provider.only.join(", ")}` : "",
      provider.ignore?.length ? `Ausgeschlossen: ${provider.ignore.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
}

async function fallbackCommand(args: string[], context: CommandContext): Promise<void> {
  const action = (args[0] ?? "").toLowerCase();
  if (!action) {
    context.out.text(
      context.config.fallbackModels.length
        ? `Fallback-Kette: ${context.config.mainModel} → ${context.config.fallbackModels.join(" → ")}`
        : `Fallback-Kette: ${context.config.mainModel} (keine Fallbacks)`,
    );
    context.out.text(chalk.dim("Setzen: /fallback +<modell> · /fallback -<modell> · /fallback clear"));
    return;
  }
  if (action === "clear") {
    context.config.fallbackModels = [];
  } else if (args[0]?.startsWith("+")) {
    const model = args[0].slice(1).trim();
    if (!model) {
      throw new Error("Verwendung: /fallback +<anbieter/modell>");
    }
    const next = new Set(context.config.fallbackModels);
    next.add(model);
    context.config.fallbackModels = [...next];
  } else if (args[0]?.startsWith("-")) {
    const model = args[0].slice(1).trim();
    context.config.fallbackModels = context.config.fallbackModels.filter(
      (entry) => entry !== model,
    );
  } else {
    throw new Error("Verwendung: /fallback [+<modell>|-<modell>|clear]");
  }
  await saveContextConfig(context);
  context.out.text(
    context.config.fallbackModels.length
      ? chalk.green(`Fallback-Kette: ${context.config.mainModel} → ${context.config.fallbackModels.join(" → ")}`)
      : chalk.green("Fallback-Kette geleert."),
  );
}

function includesValue<T extends readonly string[]>(list: T, value: string): value is T[number] {
  return (list as readonly string[]).includes(value);
}

async function initInstructions(context: CommandContext): Promise<void> {
  const target = await context.agent.guard.resolvePath("ORCODE.md");
  // Also refuse to overwrite a pre-rename `ROUTERCODE.md`: creating a second,
  // redundant instructions file next to it would be more confusing than
  // helpful, and `loadProjectNotes` already reads both if both exist.
  const legacyTarget = await context.agent.guard.resolvePath("ROUTERCODE.md");
  for (const [existing, label] of [
    [target, "ORCODE.md"],
    [legacyTarget, "ROUTERCODE.md"],
  ] as const) {
    try {
      await readFile(existing, "utf8");
      context.out.text(`${label} existiert bereits und wurde nicht überschrieben.`);
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  await context.approvals.authorize(
    writeApprovalRequest("init", context.agent.guard.display(target), {
      summary: "ORCODE.md im Workspace anlegen",
      details:
        "Projektbefehle, Konventionen, Grenzen und Definition-of-Done können dort dauerhaft eingetragen werden.",
    }),
  );
  await writeFile(
    target,
    `# orcode project instructions

## Project

- Describe the project and important directories.

## Commands

- Build:
- Test:
- Lint:

## Conventions

- Add project-specific coding and review rules here.

## Safety

- Add paths or operations the agent must not touch.

## Done means

- Define the checks required before work is considered complete.
`,
    { encoding: "utf8", mode: 0o644 },
  );
  context.out.text(chalk.green(`Angelegt: ${target}`));
}

/**
 * `/ssh`: lists hosts from `~/.ssh/config`, checks one, or ends the
 * remembered session. Never asks for or forwards a password — reachability
 * and auth both ride on `ssh -o BatchMode=yes`, so a missing key comes back
 * as a clear message instead of a hang. See `src/ssh.ts`/`src/ssh-config.ts`.
 */
async function sshCommand(args: string[], context: CommandContext): Promise<void> {
  const runSsh: RunSsh =
    context.sshRunner ??
    ((sshArgs, runOptions) => runProcess("ssh", sshArgs, runOptions));
  // `checkHost`/`closeSshControl` create the ControlMaster socket directory
  // as a side effect even with a fake `runSsh` — this MUST stay overridable,
  // or a test without `sshAppHome` silently touches the real ~/.orcode.
  const runtime = context.sshAppHome ? { appHome: context.sshAppHome } : {};
  const first = (args[0] ?? "").toLowerCase();

  if (first === "off") {
    const active = context.sshSession?.active ?? null;
    if (!active) {
      context.out.text("Keine aktive SSH-Sitzung.");
      return;
    }
    await closeSshControl(active, runSsh, runtime);
    context.sshSession!.active = null;
    context.out.text(chalk.green(`SSH-Sitzung zu „${active}“ getrennt.`));
    return;
  }

  if (first === "status") {
    const active = context.sshSession?.active ?? null;
    if (!active) {
      context.out.text("Kein aktives SSH-Ziel. Verwendung: /ssh <alias>");
      return;
    }
    const hosts = await loadSshHosts({ configPath: context.sshConfigPath });
    const result = await checkHost(active, hosts, runSsh, runtime);
    context.out.text(`Aktives SSH-Ziel: ${active} — ${result.message}`);
    return;
  }

  const hosts = await loadSshHosts({ configPath: context.sshConfigPath });
  if (!first) {
    if (!hosts.length) {
      context.out.text("Keine benannten Hosts in ~/.ssh/config gefunden.");
      return;
    }
    context.out.text(chalk.bold("SSH-Hosts aus ~/.ssh/config"));
    const active = context.sshSession?.active;
    for (const host of hosts) {
      const marker = active === host.alias ? chalk.green(" (aktiv)") : "";
      context.out.text(
        `  ${host.alias}${marker} → ${host.hostName}${host.user ? ` (${host.user})` : ""}`,
      );
    }
    context.out.text("Verwendung: /ssh <alias> | /ssh status | /ssh off");
    return;
  }

  const alias = args[0]!;
  const result = await checkHost(alias, hosts, runSsh, runtime);
  if (result.status === "reachable") {
    if (!context.sshSession) {
      context.sshSession = createSshSession();
    }
    context.sshSession.active = alias;
    context.out.text(chalk.green(result.message));
    context.out.text(
      `SSH-Ziel gesetzt: ${alias}. ssh_command läuft ab jetzt gegen diesen Host, bis /ssh off.`,
    );
    return;
  }
  context.out.text(result.status === "no-auth" ? chalk.yellow(result.message) : chalk.red(result.message));
}

function tokenize(value: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    result.push(match[1] ?? match[2] ?? match[3]);
  }
  return result;
}

function usd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 5 : 2)}`;
}

function compactNumber(value: number): string {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

async function selectModel(
  model: ModelInfo,
  context: CommandContext,
): Promise<void> {
  context.config.mainModel = model.id;
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
  );
  await Promise.all([saveContextConfig(context), context.session.save()]);
  printModelDetails(model, true, context.out);
}

export function rankModels(
  models: ModelInfo[],
  term: string,
  currentModel: string,
): ModelInfo[] {
  const needle = term.trim().toLowerCase();
  return models
    .filter((model) => {
      if (!needle) {
        return true;
      }
      const fields = needle.length < 3
        ? [model.id, model.name]
        : [
            model.id,
            model.name,
            model.description,
            model.modality ?? "",
            ...model.supportedParameters,
          ];
      const haystack = fields
        .join(" ")
        .toLowerCase();
      return needle.split(/\s+/).every((part) => haystack.includes(part));
    })
    .map((model, index) => ({
      model,
      score: modelSearchScore(model, needle, currentModel) - index / 10_000,
    }))
    .sort((left, right) => right.score - left.score)
    .map(({ model }) => model);
}

export function isTextGenerationModel(model: ModelInfo): boolean {
  return (
    model.inputModalities.includes("text") &&
    model.outputModalities.includes("text")
  );
}

export async function pickModel(
  models: ModelInfo[],
  currentModel: string,
): Promise<ModelInfo> {
  return search<ModelInfo>({
    message: "Modell suchen (tippen, ↑/↓ wählen, Enter übernehmen):",
    pageSize: 12,
    source: async (term) =>
      rankModels(models, term ?? "", currentModel)
        .slice(0, 80)
        .map((model) => ({
          value: model,
          name: `${model.name}  [${model.id}]`,
          short: model.id,
          description: modelChoiceDescription(model),
        })),
  });
}

export function formatPricePerMillion(perToken: number): string {
  if (perToken < 0) {
    return "variabel";
  }
  if (perToken === 0) {
    return "kostenlos";
  }
  return `$${(perToken * 1_000_000).toFixed(3)}/M`;
}

export function modelChoiceDescription(model: ModelInfo): string {
  const capabilities = capabilityLabels(model).join(", ") || "Text";
  const description = truncate(model.description.replace(/\s+/g, " ").trim(), 320);
  return [
    `${priceSummary(model)} · Kontext ${compactNumber(model.contextLength)} · ${capabilities}`,
    description,
  ]
    .filter(Boolean)
    .join("\n");
}

function printModelDetails(model: ModelInfo, selected: boolean, out: CommandOutput): void {
  out.text(chalk.bold.green(selected ? "\nModell ausgewählt" : "\nAktives Modell"));
  out.text(`Name: ${model.name}`);
  out.text(`ID: ${chalk.cyan(model.id)}`);
  out.text(`Anbieter: ${model.id.split("/")[0] ?? "unbekannt"} · Routing: OpenRouter`);
  out.text(`Preis: ${priceSummary(model)}`);
  out.text(
    `Kontext: ${model.contextLength.toLocaleString("de-DE")} Tokens${
      model.maxCompletionTokens
        ? ` · maximale Ausgabe ${model.maxCompletionTokens.toLocaleString("de-DE")}`
        : ""
    }`,
  );
  const capabilities = capabilityLabels(model);
  if (capabilities.length) {
    out.text(`Fähigkeiten: ${capabilities.join(", ")}`);
  }
  if (model.reasoning?.supportedEfforts?.length) {
    out.text(`Reasoning-Stufen: ${model.reasoning.supportedEfforts.join(", ")}`);
  }
  if (model.reasoning?.supportsMaxTokens) {
    out.text("Reasoning-Token-Budget: unterstützt");
  }
  const scores = [
    model.intelligenceIndex === undefined ? "" : `Intelligenz ${model.intelligenceIndex}`,
    model.codingIndex === undefined ? "" : `Coding ${model.codingIndex}`,
    model.agenticIndex === undefined ? "" : `Agentisch ${model.agenticIndex}`,
  ].filter(Boolean);
  if (scores.length) {
    out.text(`Artificial-Analysis-Indizes: ${scores.join(" · ")}`);
  }
  if (model.description) {
    out.text(`Info: ${truncate(model.description, 700)}`);
  }
  out.text("");
}

async function findCurrentModel(
  openRouter: OpenRouterService,
  modelId: string,
): Promise<ModelInfo | null> {
  try {
    const models = await openRouter.listModels(modelId, false);
    return models.find((model) => model.id === modelId) ?? null;
  } catch {
    return null;
  }
}

function normalizeReasoningEffort(value: string): ReasoningEffort | null {
  const normalized =
    value === "ultra" || value === "ultrahigh" ? "xhigh" : value;
  return REASONING_EFFORTS.includes(normalized as ReasoningEffort)
    ? normalized as ReasoningEffort
    : null;
}

function modelSearchScore(
  model: ModelInfo,
  needle: string,
  currentModel: string,
): number {
  let score = model.id === currentModel ? 20_000 : 0;
  if (!needle) {
    score += model.id === "openrouter/auto" ? 10_000 : 0;
    score += (model.codingIndex ?? 0) * 10;
    score += (model.agenticIndex ?? 0) * 3;
    return score;
  }
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  if (id === needle) score += 15_000;
  if (name === needle) score += 14_000;
  if (name.startsWith(needle)) score += 8_000;
  if (id.startsWith(needle)) score += 7_000;
  if (new RegExp(`(^|[/\\s:_-])${escapeRegExp(needle)}`).test(id)) score += 6_000;
  if (new RegExp(`(^|[/\\s:_-])${escapeRegExp(needle)}`).test(name)) score += 5_000;
  if (id.includes(needle)) score += 2_000;
  if (name.includes(needle)) score += 1_500;
  score += (model.codingIndex ?? 0) * 2;
  return score;
}

function priceSummary(model: ModelInfo): string {
  if (model.promptPrice < 0 || model.completionPrice < 0) {
    return "dynamisch/abhängig vom gerouteten Modell";
  }
  if (model.promptPrice === 0 && model.completionPrice === 0) {
    return "kostenlos";
  }
  return `Input ${formatPricePerMillion(model.promptPrice)} · Output ${formatPricePerMillion(model.completionPrice)}`;
}

function capabilityLabels(model: ModelInfo): string[] {
  const labels: string[] = [];
  if (model.supportedParameters.includes("tools")) labels.push("Tools");
  if (model.supportedParameters.includes("reasoning")) labels.push("Reasoning");
  if (model.supportedParameters.includes("structured_outputs")) labels.push("Structured Output");
  if (model.inputModalities.includes("image")) labels.push("Bilder");
  if (model.inputModalities.includes("audio")) labels.push("Audio");
  if (model.isModerated) labels.push("moderiert");
  return labels;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function persistCredential(
  credentials: CredentialStoreLike,
  kind: "inference" | "management",
  secret: string,
  out: CommandOutput,
): Promise<boolean> {
  try {
    await credentials.set(kind, secret);
    return true;
  } catch (error) {
    out.text(
      chalk.yellow(
        `Der Key ist gültig, konnte aber nicht dauerhaft gespeichert werden: ${errorMessage(error)}`,
      ),
    );
    return false;
  }
}

/**
 * Should the stored key be thrown away and replaced?
 *
 * Only for credentials the server actually rejected (401/403) or a key whose
 * validity has run out. Empty credit and an exhausted spending limit are money
 * problems with a perfectly valid key — the old regex on the German message
 * deleted exactly those keys from the keychain (B3).
 */
export function shouldReplaceCredential(error: unknown): boolean {
  if (error instanceof SpendUnavailableError) {
    return error.reason === "key-expired";
  }
  return (
    error instanceof OpenRouterHttpError &&
    (error.status === 401 || error.status === 403)
  );
}

function originLabel(origin: KeyOrigin): string {
  if (origin === "keychain") return "Gespeicherter API-Key";
  if (origin === "environment") return "OPENROUTER_API_KEY";
  return "API-Key";
}

function keyStatusLabel(origin: KeyOrigin, location: string): string {
  if (origin === "keychain") return `gespeichert im ${location}`;
  if (origin === "environment") return "aus Umgebungsvariable";
  if (origin === "interactive") return "nur im Prozessspeicher";
  return "nicht gesetzt";
}
