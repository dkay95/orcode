import { confirm, password, search } from "@inquirer/prompts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { RouterCodeAgent, assertSpendAvailable } from "./agent.js";
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
  type RouterCodeConfig,
} from "./types.js";
import { CONFIG_PATH, isApprovalMode, isCompressionMode, saveConfig } from "./config.js";
import { approvalDescription, ApprovalManager } from "./approval.js";
import type { CredentialStoreLike } from "./credentials.js";
import {
  OpenRouterHttpError,
  OpenRouterService,
  type KeyOrigin,
} from "./openrouter.js";
import { rankChatMatches, SessionStore } from "./session.js";
import { getGitDiff } from "./workspace.js";
import {
  getReasoningSetting,
  reasoningLabel,
  setReasoningSetting,
  validateReasoningSetting,
} from "./reasoning.js";
import { errorMessage, hasCode, truncate } from "./utils.js";

export interface CommandContext {
  config: RouterCodeConfig;
  approvals: ApprovalManager;
  openRouter: OpenRouterService;
  session: SessionStore;
  agent: RouterCodeAgent;
  workspace: string;
  credentials: CredentialStoreLike;
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
      printHelp();
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
      await printBalance(await context.openRouter.checkBalance());
      return "continue";
    case "reconnect":
      await printBalance(await context.openRouter.reconnect());
      console.log(chalk.green("OpenRouter-Verbindung ist wieder erreichbar."));
      return "continue";
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
    case "cost":
    case "costs":
      printCosts(context.session);
      return "continue";
    case "max-cost":
      await maxCostCommand(args, context);
      return "continue";
    case "steps":
      await stepsCommand(args, context);
      return "continue";
    case "history":
      printHistory(context.session, args);
      return "continue";
    case "clear":
      await clearSession(context.session);
      return "continue";
    case "diff":
      console.log(await getGitDiff(context.workspace));
      return "continue";
    case "undo":
      console.log(await context.agent.journal.undoLast(context.agent.guard, context.approvals));
      return "continue";
    case "config":
      console.log(chalk.bold(CONFIG_PATH));
      console.log(JSON.stringify(context.config, null, 2));
      return "continue";
    case "init":
      await initInstructions(context);
      return "continue";
    default:
      console.log(chalk.red(`Unbekannter Befehl: /${command}. Nutze /help.`));
      return "continue";
  }
}

export async function promptForValidKey(
  openRouter: OpenRouterService,
  credentials: CredentialStoreLike,
  fallback?: {
    key: string;
    origin: Exclude<KeyOrigin, "none">;
  },
): Promise<BalanceInfo> {
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
          );
          if (saved) {
            openRouter.setKey(activeKey, "keychain");
            console.log(
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
            console.log(
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
        console.log(
          chalk.red(
            `${originLabel(origin)} wurde abgelehnt${
              removedFromKeychain
                ? " und aus dem Schlüsselbund entfernt"
                : ""
            }: ${message}`,
          ),
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
      );
      openRouter.setKey(candidate, saved ? "keychain" : "interactive");
      console.log(
        chalk.green(
          saved
            ? `API-Key gültig und sicher im ${credentials.location} gespeichert.`
            : "API-Key gültig. Er bleibt für diese Sitzung im Prozessspeicher.",
        ),
      );
      return balance;
    } catch (error) {
      console.log(chalk.red(temporary.safeMessage(error)));
    }
  }
}

export async function printBalance(
  balance: Awaited<ReturnType<OpenRouterService["checkBalance"]>>,
): Promise<void> {
  console.log(chalk.bold("OpenRouter-Status"));
  console.log(`Key gültig: ${chalk.green("ja")}`);
  console.log(`Tarif: ${balance.key.isFreeTier ? "Free Tier" : "bezahlt/individuell"}`);
  if (balance.key.limit !== null && balance.key.limit !== undefined) {
    console.log(
      `Key-Limit: ${usd(balance.key.limit)} · verbleibend ${usd(balance.key.limitRemaining ?? 0)}`,
    );
  } else {
    console.log(`Key-Nutzung: ${usd(balance.key.usage ?? 0)} · kein eigenes Key-Limit`);
  }
  if (balance.credits) {
    console.log(
      `Kontoguthaben: ${usd(balance.credits.remaining)} verbleibend · ${usd(balance.credits.totalUsage)} genutzt`,
    );
  } else if (balance.creditsUnavailableReason) {
    console.log(chalk.yellow(balance.creditsUnavailableReason));
  }
  if (balance.key.expiresAt) {
    console.log(`Key läuft ab: ${balance.key.expiresAt}`);
  }
}

function printHelp(): void {
  console.log(`\n${chalk.bold("RouterCode Befehle")}`);
  const width = Math.max(...SLASH_COMMANDS.map((command) => command.usage.length));
  for (const command of SLASH_COMMANDS) {
    console.log(`  ${command.usage.padEnd(width)}  ${command.description}`);
  }
  console.log();
}

function printStatus(context: CommandContext): void {
  console.log(chalk.bold("RouterCode Status"));
  console.log(`Workspace: ${context.workspace}`);
  console.log(`Main-Modell: ${context.config.mainModel}`);
  console.log(
    `Thinking: ${reasoningLabel(getReasoningSetting(context.config))}`,
  );
  console.log(
    `Kompressor: ${context.config.compressionMode} · ${context.config.compressorModel} · Schwelle ${context.config.compressionThresholdChars} Zeichen`,
  );
  console.log(
    `Approval: ${context.approvals.mode} · ${approvalDescription(context.approvals.mode)}`,
  );
  console.log(
    `Grenzen: ${context.config.maxSteps} Tool-Schritte · ${usd(context.config.maxCostUsd)} Main · ${usd(context.config.compressorMaxCostUsd)} Kompressor`,
  );
  console.log(
    `API-Key: ${keyStatusLabel(context.openRouter.keyOrigin, context.credentials.location)}`,
  );
  console.log(
    `Management-Key: ${keyStatusLabel(context.openRouter.managementKeyOrigin, context.credentials.location)}`,
  );
  printCosts(context.session);
}

async function keyCommand(args: string[], context: CommandContext): Promise<void> {
  const action = (args[0] ?? "status").toLowerCase();
  if (action === "status") {
    const stored = await context.credentials.has("inference");
    console.log(`Aktiver API-Key: ${keyStatusLabel(context.openRouter.keyOrigin, context.credentials.location)}`);
    console.log(
      `Gespeicherter API-Key: ${
        stored ? `ja, im ${context.credentials.location}` : "nein"
      }`,
    );
    if (context.openRouter.hasKey) {
      await printBalance(await context.openRouter.checkBalance());
    }
    return;
  }
  if (action === "forget") {
    const removed = await context.credentials.delete("inference");
    context.openRouter.forgetKey();
    console.log(
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
    console.log(
      chalk.green(
        `Neuer Key ist gültig und im ${context.credentials.location} gespeichert.`,
      ),
    );
    await printBalance(balance);
    return;
  }
  if (action === "management") {
    const managementAction = (args[1] ?? "status").toLowerCase();
    if (managementAction === "status") {
      const stored = await context.credentials.has("management");
      console.log(
        context.openRouter.hasManagementKey
          ? `Management-Key aktiv: ${keyStatusLabel(context.openRouter.managementKeyOrigin, context.credentials.location)}.`
          : "Kein Management-Key aktiv; /balance prüft nur das Limit des Inference-Keys.",
      );
      console.log(
        `Gespeicherter Management-Key: ${
          stored ? `ja, im ${context.credentials.location}` : "nein"
        }`,
      );
      return;
    }
    if (managementAction === "forget") {
      await context.credentials.delete("management");
      context.openRouter.forgetManagementKey();
      console.log(
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
      console.log(
        chalk.green(
          `Management-Key gültig und im ${context.credentials.location} gespeichert. Kontoguthaben: ${usd(credits.remaining)} verbleibend.`,
        ),
      );
      return;
    }
    console.log("Verwendung: /key management set | status | forget");
    return;
  }
  console.log(
    "Verwendung: /key set | status | forget | /key management set | status | forget",
  );
}

export async function validateAndStoreInferenceKey(
  candidate: string,
  context: Pick<CommandContext, "credentials" | "openRouter">,
  signal?: AbortSignal,
): Promise<BalanceInfo> {
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
      printModelDetails(current, false);
    } else {
      console.log(`Aktive Modellroute: ${context.config.mainModel}`);
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
    await Promise.all([saveConfig(context.config), context.session.save()]);
    console.log(chalk.green(`Main-Modell: ${id}`));
  }
}

async function modelsCommand(args: string[], context: CommandContext): Promise<void> {
  const query = args.join(" ");
  const models = await context.openRouter.listModels(query, true);
  if (!models.length) {
    console.log("Keine passenden tool-fähigen Modelle gefunden.");
    return;
  }
  console.log(chalk.bold(`Tool-fähige Modelle${query ? ` für „${query}“` : ""}`));
  for (const model of models.slice(0, 30)) {
    console.log(
      `${model.id.padEnd(52)} in ${formatPricePerMillion(model.promptPrice).padStart(11)} · out ${formatPricePerMillion(model.completionPrice).padStart(11)} · ctx ${compactNumber(model.contextLength)}`,
    );
  }
  if (models.length > 30) {
    console.log(chalk.dim(`${models.length - 30} weitere; Suche mit /models <begriff> eingrenzen.`));
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
    console.log(
      `Thinking für ${context.config.mainModel}: ${reasoningLabel(current)}`,
    );
    if (model?.reasoning?.supportedEfforts) {
      console.log(
        `Unterstützte Stufen: ${model.reasoning.supportedEfforts.join(", ")}`,
      );
    } else if (
      model &&
      !model.id.startsWith("openrouter/") &&
      !model.supportedParameters.includes("reasoning")
    ) {
      console.log("Dieses Modell meldet keine Reasoning-Unterstützung.");
    } else {
      console.log(`Gateway-Stufen: ${REASONING_EFFORTS.join(", ")}`);
    }
    if (model?.reasoning?.supportsMaxTokens || model?.id.startsWith("openrouter/")) {
      console.log("Token-Budget wird unterstützt: /think budget <Tokens>");
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
  await Promise.all([saveConfig(context.config), context.session.save()]);
  console.log(
    chalk.green(
      `Thinking für ${context.config.mainModel}: ${reasoningLabel(setting)}`,
    ),
  );
}

async function approvalCommand(args: string[], context: CommandContext): Promise<void> {
  const mode = (args[0] ?? "").toLowerCase();
  if (!mode) {
    for (const candidate of APPROVAL_MODES) {
      console.log(
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
      console.log("Approval-Modus unverändert.");
      return;
    }
  }
  context.approvals.mode = mode;
  context.config.approvalMode = mode;
  await saveConfig(context.config);
  console.log(chalk.green(`Approval-Modus: ${mode}`));
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
    printCurrentChat(context.session);
    return;
  }

  if (action === "list") {
    const chats = await SessionStore.list(context.workspace);
    if (!chats.length) {
      console.log("Noch keine gespeicherten Chats in diesem Workspace.");
      return;
    }
    for (const chat of chats) {
      const marker = chat.id === context.session.data.id ? chalk.green("●") : "○";
      console.log(
        `${marker} ${chat.title} · ${chat.turnCount} Nachrichten · ${usd(chat.costUsd)} · ${formatChatDate(chat.updatedAt)} · ${chat.id}`,
      );
    }
    return;
  }

  if (action === "current") {
    printCurrentChat(context.session);
    return;
  }

  if (action === "new") {
    const title = args.slice(1).join(" ").trim() || "Neuer Chat";
    await replaceSession(
      context,
      SessionStore.create(context.workspace, undefined, title),
    );
    printCurrentChat(context.session);
    return;
  }

  if (action === "rename") {
    const title = args.slice(1).join(" ").trim();
    if (!title) {
      throw new Error("Verwendung: /chat rename <Titel>");
    }
    context.session.rename(title);
    await context.session.save();
    printCurrentChat(context.session);
    return;
  }

  if (action === "fork") {
    await saveSessionPreferences(context);
    const title = args.slice(1).join(" ").trim() ||
      `${context.session.data.title} (Fork)`;
    await replaceSession(context, await context.session.fork(title));
    printCurrentChat(context.session);
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
      printCurrentChat(context.session);
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
    printCurrentChat(context.session);
    return;
  }

  if (action === "search") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      throw new Error("Verwendung: /chat search <Suchbegriff>");
    }
    const hits = await SessionStore.search(context.workspace, query);
    if (!hits.length) {
      console.log(`Keine Chats gefunden für: ${query}`);
      return;
    }
    const shown = hits.slice(0, 10);
    for (const hit of shown) {
      const marker = hit.chat.id === context.session.data.id ? chalk.green("●") : "○";
      console.log(
        `${marker} ${hit.chat.title} · ${hit.chat.turnCount} Nachrichten · ${usd(hit.chat.costUsd)} · ${formatChatDate(hit.chat.updatedAt)} · ${hit.chat.id}`,
      );
      if (hit.snippet) {
        console.log(`  ${chalk.dim(hit.snippet)}`);
      }
    }
    if (hits.length > shown.length) {
      console.log(chalk.dim(`… und ${hits.length - shown.length} weitere Treffer.`));
    }
    console.log(chalk.dim("Öffnen mit /chat open <ID oder Titel>"));
    return;
  }

  throw new Error(
    "Verwendung: /chat [list|new [Titel]|open <ID|Titel>|search <Begriff>|rename <Titel>|fork [Titel]|current]",
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
  context.agent = await RouterCodeAgent.create({
    openRouter: context.openRouter,
    approvals: context.approvals,
    session: next,
    config: context.config,
    workspace: context.workspace,
  });
  next.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
  );
  await Promise.all([next.save(), saveConfig(context.config)]);
}

async function saveSessionPreferences(context: CommandContext): Promise<void> {
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
  );
  await context.session.save();
}

function printCurrentChat(session: SessionStore): void {
  console.log(
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
    console.log(
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
  await saveConfig(context.config);
  console.log(
    chalk.green(
      `Kompressor: ${context.config.compressionMode} · ${context.config.compressorModel} · ${context.config.compressionThresholdChars} Zeichen`,
    ),
  );
}

async function maxCostCommand(args: string[], context: CommandContext): Promise<void> {
  if (!args[0]) {
    console.log(`Main-Kostenlimit pro Lauf: ${usd(context.config.maxCostUsd)}`);
    return;
  }
  const value = Number(args[0]);
  if (!Number.isFinite(value) || value < 0.001 || value > 1_000) {
    throw new Error("Kostenlimit muss zwischen 0.001 und 1000 USD liegen.");
  }
  context.config.maxCostUsd = value;
  await saveConfig(context.config);
  console.log(chalk.green(`Main-Kostenlimit: ${usd(value)}`));
}

async function stepsCommand(args: string[], context: CommandContext): Promise<void> {
  if (!args[0]) {
    console.log(`Maximale Tool-Schritte: ${context.config.maxSteps}`);
    return;
  }
  const value = Number(args[0]);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Tool-Schritte müssen zwischen 1 und 100 liegen.");
  }
  context.config.maxSteps = value;
  await saveConfig(context.config);
  console.log(chalk.green(`Maximale Tool-Schritte: ${value}`));
}

function printCosts(session: SessionStore): void {
  const costs = session.data.costs;
  console.log(
    `Sitzungskosten: Main ${usd(costs.mainUsd)} · Kompressor ${usd(costs.compressorUsd)} · Gesamt ${usd(costs.totalUsd)}`,
  );
}

function printHistory(session: SessionStore, args: string[]): void {
  const requested = Number(args[0] ?? 10);
  const count = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), 50) : 10;
  const turns = session.recentTurns(count);
  if (!turns.length) {
    console.log("Kein Gesprächsverlauf.");
    return;
  }
  for (const turn of turns) {
    console.log(
      `\n${chalk.bold(turn.role === "user" ? "Du" : "RouterCode")} ${chalk.dim(turn.createdAt)}\n${truncate(turn.content, 2_000)}`,
    );
  }
}

async function clearSession(session: SessionStore): Promise<void> {
  const accepted = await confirm({
    message: "Gesprächskontext und aufgezeichnete Sitzungskosten zurücksetzen?",
    default: false,
  });
  if (!accepted) {
    return;
  }
  session.clear();
  await session.save();
  console.log("Sitzung zurückgesetzt.");
}

async function initInstructions(context: CommandContext): Promise<void> {
  const target = join(context.workspace, "ROUTERCODE.md");
  try {
    await readFile(target, "utf8");
    console.log("ROUTERCODE.md existiert bereits und wurde nicht überschrieben.");
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw error;
    }
  }
  await context.approvals.authorize({
    name: "init",
    risk: "edit",
    summary: "ROUTERCODE.md im Workspace anlegen",
    details: "Projektbefehle, Konventionen, Grenzen und Definition-of-Done können dort dauerhaft eingetragen werden.",
  });
  await writeFile(
    target,
    `# RouterCode project instructions

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
  console.log(chalk.green(`Angelegt: ${target}`));
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
  await Promise.all([saveConfig(context.config), context.session.save()]);
  printModelDetails(model, true);
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

function printModelDetails(model: ModelInfo, selected: boolean): void {
  console.log(chalk.bold.green(selected ? "\nModell ausgewählt" : "\nAktives Modell"));
  console.log(`Name: ${model.name}`);
  console.log(`ID: ${chalk.cyan(model.id)}`);
  console.log(`Anbieter: ${model.id.split("/")[0] ?? "unbekannt"} · Routing: OpenRouter`);
  console.log(`Preis: ${priceSummary(model)}`);
  console.log(
    `Kontext: ${model.contextLength.toLocaleString("de-DE")} Tokens${
      model.maxCompletionTokens
        ? ` · maximale Ausgabe ${model.maxCompletionTokens.toLocaleString("de-DE")}`
        : ""
    }`,
  );
  const capabilities = capabilityLabels(model);
  if (capabilities.length) {
    console.log(`Fähigkeiten: ${capabilities.join(", ")}`);
  }
  if (model.reasoning?.supportedEfforts?.length) {
    console.log(`Reasoning-Stufen: ${model.reasoning.supportedEfforts.join(", ")}`);
  }
  if (model.reasoning?.supportsMaxTokens) {
    console.log("Reasoning-Token-Budget: unterstützt");
  }
  const scores = [
    model.intelligenceIndex === undefined ? "" : `Intelligenz ${model.intelligenceIndex}`,
    model.codingIndex === undefined ? "" : `Coding ${model.codingIndex}`,
    model.agenticIndex === undefined ? "" : `Agentisch ${model.agenticIndex}`,
  ].filter(Boolean);
  if (scores.length) {
    console.log(`Artificial-Analysis-Indizes: ${scores.join(" · ")}`);
  }
  if (model.description) {
    console.log(`Info: ${truncate(model.description, 700)}`);
  }
  console.log();
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
): Promise<boolean> {
  try {
    await credentials.set(kind, secret);
    return true;
  } catch (error) {
    console.log(
      chalk.yellow(
        `Der Key ist gültig, konnte aber nicht dauerhaft gespeichert werden: ${errorMessage(error)}`,
      ),
    );
    return false;
  }
}

export function shouldReplaceCredential(error: unknown): boolean {
  if (
    error instanceof OpenRouterHttpError &&
    (error.status === 401 || error.status === 403)
  ) {
    return true;
  }
  const message = errorMessage(error);
  return /aufgebraucht|abgelaufen/i.test(message);
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
