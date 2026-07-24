#!/usr/bin/env node

import { input, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { format as formatValue, promisify } from "node:util";
import { RouterCodeAgent, assertSpendAvailable } from "./agent.js";
import { ApprovalManager } from "./approval.js";
import {
  handleSlashCommand,
  printBalance,
  promptForValidKey,
  isTextGenerationModel,
  rankModels,
  shouldReplaceCredential,
  validateAndStoreInferenceKey,
  validateAndStoreManagementKey,
} from "./commands.js";
import {
  isApprovalMode,
  isCompressionMode,
  loadConfig,
  saveConfig,
} from "./config.js";
import {
  CredentialStore,
  type CredentialKind,
} from "./credentials.js";
import { OpenRouterService } from "./openrouter.js";
import {
  getReasoningSetting,
  reasoningChoiceValue,
  reasoningChoices,
  reasoningLabel,
  setReasoningSetting,
  validateReasoningSetting,
} from "./reasoning.js";
import { SessionStore } from "./session.js";
import {
  TerminalUi,
  UiExitError,
  sanitizeTerminalText,
  type DashboardState,
} from "./tui.js";
import type {
  ApprovalMode,
  BalanceInfo,
  ChatSummary,
  ModelInfo,
  RouterCodeConfig,
} from "./types.js";
import { APPROVAL_MODES } from "./types.js";
import { approvalDescription } from "./approval.js";
import { sanitizedEnvironment } from "./workspace.js";

const execFileAsync = promisify(execFile);

interface CliOptions {
  workspace: string;
  prompt?: string;
  model?: string;
  approval?: string;
  compression?: string;
  chatId?: string;
  newChat: boolean;
  continueChat: boolean;
  help: boolean;
  plain: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const config = await loadConfig();
  if (options.model) {
    config.mainModel = options.model;
  }
  if (options.approval) {
    if (!isApprovalMode(options.approval)) {
      throw new Error(`Ungültiger Approval-Modus: ${options.approval}`);
    }
    config.approvalMode = options.approval;
  }
  if (options.compression) {
    if (!isCompressionMode(options.compression)) {
      throw new Error(`Ungültiger Kompressor-Modus: ${options.compression}`);
    }
    config.compressionMode = options.compression;
  }

  const workspace = resolve(options.workspace);
  const credentials = new CredentialStore();
  const storedInferenceKey = await loadStoredCredential(
    credentials,
    "inference",
  );
  const storedManagementKey = await loadStoredCredential(
    credentials,
    "management",
  );
  const environmentInferenceKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  const environmentManagementKey =
    process.env.OPENROUTER_MANAGEMENT_KEY?.trim() || null;
  const openRouter = new OpenRouterService(
    storedInferenceKey ?? environmentInferenceKey ?? undefined,
    storedManagementKey ?? environmentManagementKey ?? undefined,
    {
      inference: storedInferenceKey ? "keychain" : "environment",
      management: storedManagementKey ? "keychain" : "environment",
    },
  );
  const approvals = new ApprovalManager(config.approvalMode);
  let session: SessionStore;
  if (options.newChat) {
    session = SessionStore.create(workspace);
  } else if (options.chatId) {
    session = await SessionStore.openById(workspace, options.chatId);
  } else {
    session = await SessionStore.open(workspace);
  }
  if (!options.model && session.data.model) {
    config.mainModel = session.data.model;
  }
  if (!options.model && session.data.reasoning) {
    setReasoningSetting(config, session.data.reasoning);
  }
  session.setPreferences(
    config.mainModel,
    getReasoningSetting(config),
  );
  const agent = await RouterCodeAgent.create({
    openRouter,
    approvals,
    session,
    config,
    workspace,
  });

  const useTui = Boolean(
    !options.prompt &&
    !options.plain &&
    process.stdin.isTTY &&
    process.stdout.isTTY,
  );
  if (!useTui) {
    printBanner(workspace, config.mainModel);
  }
  if (useTui) {
    await runDashboard({
      workspace,
      config,
      approvals,
      openRouter,
      session,
      agent,
      credentials,
      showChatPickerOnStart:
        !options.newChat && !options.continueChat && !options.chatId,
      initialKeyFallback:
        storedInferenceKey && environmentInferenceKey
          ? environmentInferenceKey
          : undefined,
    });
    return;
  }

  if (approvals.mode === "allow-all" && process.stdin.isTTY) {
    const keep = await confirm({
      message: "allow-all ist gespeichert. Für diese Sitzung wirklich ohne Rückfragen arbeiten?",
      default: false,
    });
    if (!keep) {
      approvals.mode = "ask";
      console.log("Diese Sitzung verwendet ask; die gespeicherte Einstellung bleibt unverändert.");
    }
  }

  const startupBalance = await promptForValidKey(
    openRouter,
    credentials,
    storedInferenceKey && environmentInferenceKey
      ? {
          key: environmentInferenceKey,
          origin: "environment",
        }
      : undefined,
  );

  if (options.prompt) {
    await printBalance(startupBalance);
    const result = await agent.run(options.prompt);
    printRunFooter(result);
    return;
  }

  await printBalance(startupBalance);
  await runPlainLoop({
    workspace,
    config,
    approvals,
    openRouter,
    session,
    agent,
    credentials,
  });
}

interface RuntimeContext {
  workspace: string;
  config: RouterCodeConfig;
  approvals: ApprovalManager;
  openRouter: OpenRouterService;
  session: SessionStore;
  agent: RouterCodeAgent;
  credentials: CredentialStore;
}

async function runPlainLoop(context: RuntimeContext): Promise<void> {
  console.log(chalk.dim("Schreibe eine Aufgabe oder /help. Ctrl+C beendet.\n"));
  while (true) {
    let value: string;
    try {
      value = await input({
        message: chalk.cyan("›"),
      });
    } catch (error) {
      if (isPromptExit(error)) {
        process.stdout.write("\n");
        break;
      }
      throw error;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    try {
      if (trimmed.startsWith("/")) {
        const outcome = await handleSlashCommand(trimmed, context);
        if (outcome === "exit") {
          break;
        }
        continue;
      }
      const result = await context.agent.run(trimmed);
      printRunFooter(result);
    } catch (error) {
      console.error(chalk.red(context.openRouter.safeMessage(error)));
      if (
        !context.openRouter.hasKey ||
        shouldReplaceCredential(error)
      ) {
        await printBalance(
          await promptForValidKey(
            context.openRouter,
            context.credentials,
          ),
        );
      }
    }
  }

  await context.session.save();
  console.log("Bis bald.");
}

async function runDashboard(
  context: RuntimeContext & {
    initialKeyFallback?: string;
    showChatPickerOnStart?: boolean;
  },
): Promise<void> {
  let balance: BalanceInfo | null = null;
  let balanceLabel = "wird geprüft …";
  let resolvedModel = "";
  let projectStatus = `${basename(context.workspace)} · Workspace wird geprüft …`;
  let modelDetails = "Modellmetadaten werden geladen …";
  let currentModelInfo: ModelInfo | null = null;
  let startingSessionCost = context.session.data.costs.totalUsd;
  const ui = new TerminalUi((): DashboardState => {
    const spentSinceStart = Math.max(
      0,
      context.session.data.costs.totalUsd - startingSessionCost,
    );
    return {
      workspace: context.workspace,
      projectStatus: `${projectStatus} · Chat „${context.session.data.title}“ · ${context.session.data.turns.length} Nachrichten`,
      model: context.config.mainModel,
      modelDetails,
      resolvedModel,
      approval: context.approvals.mode,
      compressor: context.config.compressionMode,
      compressorModel: context.config.compressorModel,
      reasoning: reasoningLabel(getReasoningSetting(context.config)),
      balance: balance
        ? formatBalanceSummary(balance, spentSinceStart)
        : balanceLabel,
      sessionCost: formatUsd(context.session.data.costs.totalUsd),
      maxCost: formatUsd(context.config.maxCostUsd),
      maxSteps: context.config.maxSteps,
      keyStatus: dashboardKeyStatus(context.openRouter.keyOrigin),
    };
  });
  ui.loadTurns(context.session.recentTurns(12));
  context.approvals.setPromptHandler((preview) => ui.confirmApproval(preview));
  ui.start();
  try {
    if (context.showChatPickerOnStart) {
      const switched = await pickDashboardChat(ui, context, true);
      if (switched) {
        startingSessionCost = context.session.data.costs.totalUsd;
      }
    }
    const startupModel = context.config.mainModel;
    void Promise.all([
      inspectWorkspace(context.workspace),
      loadModelSnapshot(context.openRouter, startupModel),
    ]).then(([nextProjectStatus, nextModel]) => {
      projectStatus = nextProjectStatus;
      if (context.config.mainModel === startupModel) {
        modelDetails = nextModel.details;
        currentModelInfo = nextModel.model;
      }
      ui.refresh();
    });

    if (context.approvals.mode === "allow-all") {
      const keep = await ui.confirmAction(
        "Gespeichertes allow-all für diese Sitzung verwenden?",
        "Dateiänderungen und Shell-Befehle würden ohne Rückfrage ausgeführt.",
      );
      if (!keep) {
        context.approvals.mode = "ask";
        ui.addMessage(
          "system",
          "Diese Sitzung verwendet ask; die gespeicherte Einstellung bleibt unverändert.",
          "Approval",
        );
      }
    }

    try {
      balance = await initializeDashboardKey(
        ui,
        context,
        context.initialKeyFallback,
      );
      if (!balance) {
        balanceLabel = context.openRouter.hasKey ? "nicht geprüft" : "kein Key";
        ui.addMessage(
          "system",
          context.openRouter.hasKey
            ? "API-Key ist geladen, aber die Startprüfung wurde abgebrochen. Vor einem Modelllauf wird erneut geprüft."
            : "Kein API-Key aktiv. Verwende /key set, bevor du ein Modell startest.",
          "OpenRouter",
        );
      }
    } catch (error) {
      balanceLabel = "nicht verfügbar";
      ui.addMessage(
        "error",
        `OpenRouter-Startprüfung fehlgeschlagen: ${context.openRouter.safeMessage(error)}`,
      );
    }
    ui.setStatus("Bereit", false);

    while (true) {
      let value: string;
      try {
        value = await ui.readInput();
      } catch (error) {
        if (error instanceof UiExitError) {
          break;
        }
        throw error;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }

      let runController: AbortController | null = null;
      try {
        if (trimmed.startsWith("/")) {
          ui.setStatus("Befehl wird ausgeführt");
          const modelBefore = context.config.mainModel;
          const completedCommand = commandName(trimmed);
          const commandArgs = commandArguments(trimmed);
          const sessionBefore = context.session;

          if (completedCommand === "model" && commandArgs.length === 0) {
            const selected = await pickDashboardModel(ui, context);
            if (selected) {
              context.session.setPreferences(
                context.config.mainModel,
                getReasoningSetting(context.config),
              );
              await context.session.save();
              resolvedModel = "";
              currentModelInfo = selected;
              modelDetails = summarizeModel(selected);
              ui.addMessage(
                "system",
                [
                  `Modell ausgewählt: ${selected.name}`,
                  `ID: ${selected.id}`,
                  summarizeModel(selected),
                ].join("\n"),
                "/model",
              );
            } else {
              ui.addMessage("system", "Modellwahl abgebrochen.", "/model");
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            (completedCommand === "compress" ||
              completedCommand === "compressor") &&
            commandArgs.length === 1 &&
            commandArgs[0]?.toLowerCase() === "model"
          ) {
            const selected = await pickDashboardCompressorModel(ui, context);
            if (selected) {
              ui.addMessage(
                "system",
                [
                  `Kompressor-Modell ausgewählt: ${selected.name}`,
                  `ID: ${selected.id}`,
                  summarizeModel(selected),
                  `Modus: ${context.config.compressionMode} · Schwelle ${context.config.compressionThresholdChars.toLocaleString("de-DE")} Zeichen`,
                ].join("\n"),
                "/compress model",
              );
            } else {
              ui.addMessage(
                "system",
                "Kompressor-Modellwahl abgebrochen.",
                "/compress model",
              );
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            (completedCommand === "think" ||
              completedCommand === "reasoning") &&
            commandArgs.length === 0
          ) {
            if (!currentModelInfo) {
              const snapshot = await loadModelSnapshot(
                context.openRouter,
                context.config.mainModel,
              );
              currentModelInfo = snapshot.model;
              modelDetails = snapshot.details;
            }
            const current = getReasoningSetting(context.config);
            const options = reasoningChoices(currentModelInfo, current);
            const picked = await ui.pickChoice(
              `Thinking für ${context.config.mainModel}`,
              options,
              reasoningChoiceValue(current),
            );
            const selected = options.find(
              (option) => option.value === picked?.value,
            );
            if (selected) {
              validateReasoningSetting(selected.setting, currentModelInfo);
              setReasoningSetting(context.config, selected.setting);
              context.session.setPreferences(
                context.config.mainModel,
                selected.setting,
              );
              await Promise.all([
                saveConfig(context.config),
                context.session.save(),
              ]);
              ui.addMessage(
                "system",
                [
                  `Thinking: ${reasoningLabel(selected.setting)}`,
                  selected.description,
                  "Reasoning-Tokens zählen als Output-Tokens und können die Kosten erhöhen.",
                ].join("\n"),
                "/think",
              );
            } else {
              ui.addMessage("system", "Thinking-Auswahl abgebrochen.", "/think");
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            isApprovalCommand(completedCommand) &&
            commandArgs.length === 0
          ) {
            const selected = await ui.pickChoice(
              "Approval-Modus",
              APPROVAL_MODES.map((mode) => ({
                value: mode,
                label: approvalChoiceLabel(mode),
                description: approvalDescription(mode),
              })),
              context.approvals.mode,
            );
            if (selected) {
              const mode = selected.value as ApprovalMode;
              let accepted = true;
              if (mode === "allow-all") {
                accepted = await ui.confirmAction(
                  "allow-all aktivieren?",
                  "Dateiänderungen und Shell-Befehle laufen ohne weitere Rückfrage. Katastrophale Befehle bleiben blockiert.",
                );
              }
              if (accepted) {
                const previous = context.approvals.mode;
                context.approvals.mode = mode;
                context.config.approvalMode = mode;
                await saveConfig(context.config);
                ui.addMessage(
                  "system",
                  `✓ Approval geändert: ${previous} → ${mode}\n${approvalDescription(mode)}`,
                  "/approval",
                );
              } else {
                ui.addMessage(
                  "system",
                  "Approval-Modus blieb unverändert.",
                  "/approval",
                );
              }
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            isChatCommand(completedCommand) &&
            commandArgs.length === 0
          ) {
            const switched = await pickDashboardChat(ui, context, false);
            if (switched) {
              startingSessionCost = context.session.data.costs.totalUsd;
              resolvedModel = "";
              const snapshot = await loadModelSnapshot(
                context.openRouter,
                context.config.mainModel,
              );
              modelDetails = snapshot.details;
              currentModelInfo = snapshot.model;
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            completedCommand === "key" &&
            commandArgs[0]?.toLowerCase() === "set"
          ) {
            const nextBalance = await promptDashboardInferenceKey(ui, context);
            if (nextBalance) {
              balance = nextBalance;
              ui.addMessage(
                "system",
                `Neuer OpenRouter-Key ist gültig und im ${context.credentials.location} gespeichert.`,
                "/key",
              );
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            completedCommand === "key" &&
            commandArgs[0]?.toLowerCase() === "management" &&
            commandArgs[1]?.toLowerCase() === "set"
          ) {
            const stored = await promptDashboardManagementKey(ui, context);
            if (stored) {
              balance = await context.openRouter.checkBalance();
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (completedCommand === "clear" && commandArgs.length === 0) {
            const accepted = await ui.confirmAction(
              "Gespräch und Sitzungskosten zurücksetzen?",
              "Der gespeicherte Chat-Kontext und die Kostenstatistik dieses Workspaces werden gelöscht.",
            );
            if (accepted) {
              context.session.clear();
              await context.session.save();
              ui.loadTurns([]);
              ui.addMessage("system", "Sitzung zurückgesetzt.", "/clear");
            } else {
              ui.addMessage("system", "Zurücksetzen abgebrochen.", "/clear");
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (
            isApprovalCommand(completedCommand) &&
            commandArgs[0]?.toLowerCase() === "allow-all"
          ) {
            const accepted = await ui.confirmAction(
              "allow-all aktivieren?",
              "Dateiänderungen und Shell-Befehle werden dann ohne weitere Nachfrage ausgeführt.",
            );
            if (accepted) {
              context.approvals.mode = "allow-all";
              context.config.approvalMode = "allow-all";
              await saveConfig(context.config);
              ui.addMessage(
                "system",
                "Approval-Modus: allow-all. Änderungen und Shell-Befehle laufen ohne Rückfrage.",
                "/approval",
              );
            } else {
              ui.addMessage(
                "system",
                "Approval-Modus blieb unverändert.",
                "/approval",
              );
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          let captured: Awaited<ReturnType<typeof captureConsole<"continue" | "exit">>>;
          captured = await captureConsole(
            () => handleSlashCommand(trimmed, context),
            false,
          );
          if (context.session !== sessionBefore) {
            startingSessionCost = context.session.data.costs.totalUsd;
            ui.loadTurns(context.session.recentTurns(40));
            resolvedModel = "";
          }
          if (captured.output) {
            ui.addMessage(
              captured.level === "error" ? "error" : "system",
              captured.output,
              trimmed.split(/\s+/)[0],
            );
          }
          if (
            completedCommand === "balance" ||
            completedCommand === "credits" ||
            completedCommand === "reconnect"
          ) {
            balance = await context.openRouter.checkBalance();
          }
          if (completedCommand === "key" && context.openRouter.hasKey) {
            balance = await context.openRouter.checkBalance();
          } else if (completedCommand === "key") {
            balance = null;
            balanceLabel = "kein Key";
          }
          if (
            context.config.mainModel !== modelBefore ||
            completedCommand === "model" ||
            context.session !== sessionBefore
          ) {
            resolvedModel = "";
            const snapshot = await loadModelSnapshot(
              context.openRouter,
              context.config.mainModel,
            );
            modelDetails = snapshot.details;
            currentModelInfo = snapshot.model;
          }
          if (completedCommand === "clear" && context.session.data.turns.length === 0) {
            ui.loadTurns([]);
            if (captured.output) {
              ui.addMessage("system", captured.output, "/clear");
            }
          }
          void inspectWorkspace(context.workspace).then((nextProjectStatus) => {
            projectStatus = nextProjectStatus;
            ui.refresh();
          });
          if (captured.value === "exit") {
            break;
          }
          ui.setStatus("Bereit", false);
          continue;
        }

        ui.addMessage("user", trimmed);
        ui.beginAssistant(context.config.mainModel);
        runController = new AbortController();
        ui.setCancelHandler(() => {
          runController?.abort(new Error("Der aktuelle Lauf wurde vom Benutzer abgebrochen."));
        });
        const result = await context.agent.run(trimmed, {
          onStatus: (status) => ui.setStatus(status),
          onText: (delta) => ui.appendAssistant(delta),
          onEvent: (event) => ui.handleRunEvent(event),
          signal: runController.signal,
        });
        ui.setCancelHandler();
        resolvedModel = result.resolvedModel;
        ui.finishAssistant(result.text);
        ui.setSuggestedReplies(result.suggestions);
        ui.addMessage(
          "system",
          `Lauf beendet · ${formatUsd(result.costUsd)} · ${formatRouting(result.selectedModel, result.resolvedModel)}`,
        );
        void inspectWorkspace(context.workspace).then((nextProjectStatus) => {
          projectStatus = nextProjectStatus;
          ui.refresh();
        });
      } catch (error) {
        const cancelled =
          Boolean(runController?.signal.aborted) || isCancellationError(error);
        ui.setCancelHandler();
        ui.finishAssistant();
        ui.addMessage(
          cancelled ? "system" : "error",
          cancelled
            ? "Lauf abgebrochen. Bereits ausgeführte Tool-Aktionen wurden nicht automatisch zurückgenommen."
            : context.openRouter.safeMessage(error),
        );
        if (
          !cancelled &&
          (!context.openRouter.hasKey || shouldReplaceCredential(error))
        ) {
          await discardRejectedInferenceKey(context);
          balance = null;
          balanceLabel = "kein Key";
          const nextBalance = await promptDashboardInferenceKey(ui, context);
          if (nextBalance) {
            balance = nextBalance;
            ui.addMessage(
              "system",
              `Neuer OpenRouter-Key ist gültig und im ${context.credentials.location} gespeichert.`,
            );
          }
        }
        ui.setStatus("Bereit", false);
      }
    }
  } finally {
    context.approvals.setPromptHandler(undefined);
    await context.session.save();
    ui.stop();
  }
  console.log("Bis bald.");
}

function isApprovalCommand(command: string): boolean {
  return ["approval", "allow", "approvals", "permissions"].includes(command);
}

function isChatCommand(command: string): boolean {
  return ["chat", "chats", "switch"].includes(command);
}

function approvalChoiceLabel(mode: ApprovalMode): string {
  switch (mode) {
    case "read-only":
      return "Read only";
    case "ask":
      return "Ask · alles bestätigen";
    case "auto-edit":
      return "Auto edit · Shell bestätigen";
    case "allow-all":
      return "Allow all";
  }
}

async function pickDashboardChat(
  ui: TerminalUi,
  context: RuntimeContext,
  preferNew: boolean,
): Promise<boolean> {
  await saveDashboardSessionPreferences(context);
  const chats = await SessionStore.list(context.workspace);
  const items = [
    {
      value: "__new__",
      label: "＋ Neuer Chat",
      description: "Beginnt ohne bisherigen Gesprächskontext und mit eigener Kostenstatistik.",
    },
    ...chats.map((chat) => chatChoice(chat)),
  ];
  const picked = await ui.pickChoice(
    `Chats · ${basename(context.workspace)}`,
    items,
    context.session.data.id,
    preferNew ? "__new__" : context.session.data.id,
  );
  if (!picked) {
    return false;
  }

  let next: SessionStore;
  if (picked.value === "__new__") {
    next = SessionStore.create(context.workspace);
    next.setPreferences(
      context.config.mainModel,
      getReasoningSetting(context.config),
    );
  } else {
    if (picked.value === context.session.data.id) {
      return false;
    }
    next = await SessionStore.openById(context.workspace, picked.value);
    if (next.data.model) {
      context.config.mainModel = next.data.model;
    }
    if (next.data.reasoning) {
      setReasoningSetting(context.config, next.data.reasoning);
    }
  }

  context.session = next;
  context.agent = await RouterCodeAgent.create({
    openRouter: context.openRouter,
    approvals: context.approvals,
    session: next,
    config: context.config,
    workspace: context.workspace,
  });
  await saveDashboardSessionPreferences(context);
  await saveConfig(context.config);
  ui.loadTurns(next.recentTurns(40));
  ui.setStatus(`Chat geöffnet: ${next.data.title}`, false);
  return true;
}

function chatChoice(
  chat: ChatSummary,
): {
  value: string;
  label: string;
  description: string;
} {
  const model = chat.model ? ` · ${chat.model}` : "";
  return {
    value: chat.id,
    label: chat.title,
    description: `${chat.turnCount} Nachrichten · ${formatUsd(chat.costUsd)}${model} · ${formatChatAge(chat.updatedAt)} · ${chat.id.slice(0, 8)}`,
  };
}

function formatChatAge(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "gerade eben";
  }
  if (minutes < 60) {
    return `vor ${minutes} Min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `vor ${hours} Std`;
  }
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

async function saveDashboardSessionPreferences(
  context: RuntimeContext,
): Promise<void> {
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
  );
  await context.session.save();
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    workspace: process.cwd(),
    newChat: false,
    continueChat: false,
    help: false,
    plain: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--plain") {
      options.plain = true;
    } else if (argument === "--cwd" || argument === "-C") {
      options.workspace = requireValue(args, ++index, argument);
    } else if (argument === "--prompt" || argument === "-p") {
      options.prompt = requireValue(args, ++index, argument);
    } else if (argument === "--model" || argument === "-m") {
      options.model = requireValue(args, ++index, argument);
    } else if (argument === "--approval" || argument === "-a") {
      options.approval = requireValue(args, ++index, argument);
    } else if (argument === "--compress") {
      options.compression = requireValue(args, ++index, argument);
    } else if (argument === "--new") {
      options.newChat = true;
    } else if (argument === "--continue") {
      options.continueChat = true;
    } else if (argument === "--chat") {
      options.chatId = requireValue(args, ++index, argument);
    } else if (argument.startsWith("-")) {
      throw new Error(`Unbekannte Option: ${argument}`);
    } else if (!options.prompt) {
      options.prompt = argument;
    } else {
      options.prompt += ` ${argument}`;
    }
  }
  const chatModes = [
    options.newChat,
    options.continueChat,
    Boolean(options.chatId),
  ].filter(Boolean).length;
  if (chatModes > 1) {
    throw new Error("--new, --continue und --chat können nicht kombiniert werden.");
  }
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${option} benötigt einen Wert.`);
  }
  return value;
}

function printBanner(workspace: string, model: string): void {
  console.log(chalk.bold.cyan("\nRouterCode 0.3"));
  console.log(`${chalk.dim("Workspace")} ${workspace}`);
  console.log(`${chalk.dim("Main")}      ${model}`);
}

function printUsage(): void {
  console.log(`
RouterCode – lokaler Coding-Agent über OpenRouter

Verwendung:
  routercode [optionen] [aufgabe]
  routercode -C /pfad/zum/projekt

Optionen:
  -C, --cwd <pfad>          Arbeitsverzeichnis
  -p, --prompt <text>       Einmaliger nicht-interaktiver Lauf
  -m, --model <id>          Main-Modell für diesen Start
  -a, --approval <modus>    read-only | ask | auto-edit | allow-all
      --compress <modus>    off | auto | always
      --new                 Direkt einen neuen Chat beginnen
      --continue            Zuletzt verwendeten Chat fortsetzen
      --chat <id>           Einen bestimmten Chat öffnen
      --plain               Klassische Ausgabe ohne Fullscreen-TUI
  -h, --help                Hilfe

Der API-Key wird ausschließlich über OPENROUTER_API_KEY oder die verdeckte
Eingabe beim Start angenommen und nach erfolgreicher Prüfung sicher im
System-Schlüsselbund gespeichert. Ein --key-Argument gibt es absichtlich nicht.
`);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 5 : 3)}`;
}

function printRunFooter(result: {
  costUsd: number;
  selectedModel: string;
  resolvedModel: string;
}): void {
  const routing =
    result.resolvedModel === result.selectedModel
      ? result.selectedModel
      : `${result.selectedModel} → ${result.resolvedModel}`;
  console.log(
    chalk.dim(
      `Main-Kosten dieses Laufs: ${formatUsd(result.costUsd)} · Modell: ${routing}`,
    ),
  );
}

function formatRouting(selectedModel: string, resolvedModel: string): string {
  return resolvedModel === selectedModel
    ? selectedModel
    : `${selectedModel} → ${resolvedModel}`;
}

function formatBalanceSummary(balance: BalanceInfo, spentSinceStart: number): string {
  if (balance.credits) {
    return formatUsd(Math.max(0, balance.credits.remaining - spentSinceStart));
  }
  if (
    balance.key.limitRemaining !== null &&
    balance.key.limitRemaining !== undefined
  ) {
    return `${formatUsd(Math.max(0, balance.key.limitRemaining - spentSinceStart))} Key-Limit`;
  }
  return balance.key.isFreeTier ? "Free Tier" : "Key gültig";
}

function commandName(raw: string): string {
  return raw.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

function commandArguments(raw: string): string[] {
  return raw.slice(1).trim().split(/\s+/).slice(1);
}

async function initializeDashboardKey(
  ui: TerminalUi,
  context: RuntimeContext,
  fallbackKey?: string,
): Promise<BalanceInfo | null> {
  if (!context.openRouter.hasKey) {
    return promptDashboardInferenceKey(ui, context);
  }

  const activeKey = context.openRouter.requireKey();
  const origin = context.openRouter.keyOrigin;
  const controller = new AbortController();
  ui.setStatus("Gespeicherten API-Key und Guthaben prüfen");
  ui.setCancelHandler(() => {
    controller.abort(new Error("Die OpenRouter-Startprüfung wurde abgebrochen."));
  });
  try {
    let currentBalance: BalanceInfo;
    if (origin === "keychain") {
      currentBalance = await context.openRouter.checkBalance(controller.signal);
      assertSpendAvailable(currentBalance);
    } else {
      currentBalance = await validateAndStoreInferenceKey(
        activeKey,
        context,
        controller.signal,
      );
    }
    return currentBalance;
  } catch (error) {
    if (controller.signal.aborted || isCancellationError(error)) {
      return null;
    }
    if (!shouldReplaceCredential(error)) {
      throw error;
    }
    ui.addMessage(
      "error",
      `Der bisherige API-Key wurde abgelehnt oder ist nicht mehr nutzbar: ${context.openRouter.safeMessage(error)}`,
      "OpenRouter",
    );
  } finally {
    ui.setCancelHandler();
  }

  await discardRejectedInferenceKey(context);
  if (fallbackKey && fallbackKey.trim() !== activeKey.trim()) {
    const fallbackController = new AbortController();
    ui.setStatus("OPENROUTER_API_KEY als Ersatz prüfen");
    ui.setCancelHandler(() => {
      fallbackController.abort(new Error("Die Ersatz-Key-Prüfung wurde abgebrochen."));
    });
    try {
      return await validateAndStoreInferenceKey(
        fallbackKey,
        context,
        fallbackController.signal,
      );
    } catch (error) {
      if (fallbackController.signal.aborted || isCancellationError(error)) {
        return null;
      }
      if (!shouldReplaceCredential(error)) {
        throw error;
      }
      ui.addMessage(
        "error",
        `Auch OPENROUTER_API_KEY wurde abgelehnt: ${context.openRouter.safeMessage(error)}`,
        "OpenRouter",
      );
    } finally {
      ui.setCancelHandler();
    }
  }
  return promptDashboardInferenceKey(ui, context);
}

async function pickDashboardModel(
  ui: TerminalUi,
  context: RuntimeContext,
): Promise<ModelInfo | null> {
  const controller = new AbortController();
  ui.setStatus("Tool-fähige OpenRouter-Modelle werden geladen");
  ui.setCancelHandler(() => {
    controller.abort(new Error("Das Laden der Modellliste wurde abgebrochen."));
  });
  let models: ModelInfo[];
  try {
    models = await context.openRouter.listModels("", true, controller.signal);
  } finally {
    ui.setCancelHandler();
  }
  const selected = await ui.pickModel(
    (query) => rankModels(models, query, context.config.mainModel),
    context.config.mainModel,
  );
  if (!selected) {
    return null;
  }
  context.config.mainModel = selected.id;
  await saveConfig(context.config);
  return selected;
}

async function pickDashboardCompressorModel(
  ui: TerminalUi,
  context: RuntimeContext,
): Promise<ModelInfo | null> {
  const controller = new AbortController();
  ui.setStatus("Textmodelle für den Kompressor werden geladen");
  ui.setCancelHandler(() => {
    controller.abort(
      new Error("Das Laden der Kompressor-Modellliste wurde abgebrochen."),
    );
  });
  let models: ModelInfo[];
  try {
    models = (
      await context.openRouter.listModels("", false, controller.signal)
    ).filter(isTextGenerationModel);
  } finally {
    ui.setCancelHandler();
  }
  const selected = await ui.pickModel(
    (query) => rankModels(models, query, context.config.compressorModel),
    context.config.compressorModel,
    "Kompressor-Modell auswählen",
  );
  if (!selected) {
    return null;
  }
  context.config.compressorModel = selected.id;
  await saveConfig(context.config);
  return selected;
}

async function promptDashboardInferenceKey(
  ui: TerminalUi,
  context: RuntimeContext,
): Promise<BalanceInfo | null> {
  while (true) {
    const candidate = await ui.readSecret("OpenRouter API-Key");
    if (candidate === null) {
      ui.addMessage("system", "Key-Eingabe abgebrochen.", "/key");
      return null;
    }
    if (candidate.length < 20 || /\s/.test(candidate)) {
      ui.addMessage(
        "error",
        "Der Key ist zu kurz oder enthält Leerzeichen.",
        "/key",
      );
      continue;
    }
    const controller = new AbortController();
    ui.setStatus("API-Key und Guthaben werden geprüft");
    ui.setCancelHandler(() => {
      controller.abort(new Error("Die Key-Prüfung wurde abgebrochen."));
    });
    try {
      return await validateAndStoreInferenceKey(
        candidate,
        context,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted || isCancellationError(error)) {
        ui.addMessage("system", "Key-Prüfung abgebrochen.", "/key");
        return null;
      }
      ui.addMessage("error", context.openRouter.safeMessage(error), "/key");
    } finally {
      ui.setCancelHandler();
    }
  }
}

async function promptDashboardManagementKey(
  ui: TerminalUi,
  context: RuntimeContext,
): Promise<boolean> {
  while (true) {
    const candidate = await ui.readSecret("OpenRouter Management-Key");
    if (candidate === null) {
      ui.addMessage("system", "Management-Key-Eingabe abgebrochen.", "/key");
      return false;
    }
    if (candidate.length < 20 || /\s/.test(candidate)) {
      ui.addMessage(
        "error",
        "Der Management-Key ist zu kurz oder enthält Leerzeichen.",
        "/key",
      );
      continue;
    }
    const controller = new AbortController();
    ui.setStatus("Management-Key wird geprüft");
    ui.setCancelHandler(() => {
      controller.abort(new Error("Die Management-Key-Prüfung wurde abgebrochen."));
    });
    try {
      const credits = await validateAndStoreManagementKey(
        candidate,
        context,
        controller.signal,
      );
      ui.addMessage(
        "system",
        `Management-Key gespeichert · Kontoguthaben ${formatUsd(credits.remaining)}.`,
        "/key",
      );
      return true;
    } catch (error) {
      if (controller.signal.aborted || isCancellationError(error)) {
        ui.addMessage("system", "Management-Key-Prüfung abgebrochen.", "/key");
        return false;
      }
      ui.addMessage("error", context.openRouter.safeMessage(error), "/key");
    } finally {
      ui.setCancelHandler();
    }
  }
}

async function discardRejectedInferenceKey(
  context: RuntimeContext,
): Promise<void> {
  const origin = context.openRouter.keyOrigin;
  context.openRouter.forgetKey();
  if (origin === "keychain") {
    try {
      await context.credentials.delete("inference");
    } catch {
      // A replacement can still be used in memory if Keychain cleanup fails.
    }
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.name === "RequestAbortedError" ||
    /abgebrochen|abort/i.test(error.message)
  );
}

async function captureConsole<T>(
  operation: () => Promise<T>,
  passthrough: boolean,
): Promise<{ value: T; output: string; level: "info" | "error" }> {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  let level: "info" | "error" = "info";
  console.log = (...args: unknown[]): void => {
    lines.push(formatValue(...args));
    if (passthrough) {
      originalLog(...args);
    }
  };
  console.error = (...args: unknown[]): void => {
    level = "error";
    lines.push(formatValue(...args));
    if (passthrough) {
      originalError(...args);
    }
  };
  try {
    const value = await operation();
    return {
      value,
      output: sanitizeTerminalText(lines.join("\n")).trim(),
      level,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function loadStoredCredential(
  credentials: CredentialStore,
  kind: CredentialKind,
): Promise<string | null> {
  try {
    return await credentials.get(kind);
  } catch (error) {
    console.log(
      chalk.yellow(
        `Gespeicherter ${
          kind === "inference" ? "API-Key" : "Management-Key"
        } konnte nicht geladen werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    return null;
  }
}

function dashboardKeyStatus(
  origin: OpenRouterService["keyOrigin"],
): string {
  if (origin === "keychain") return "Schlüsselbund";
  if (origin === "environment") return "Umgebung";
  if (origin === "interactive") return "Speicher";
  return "fehlt";
}

async function inspectWorkspace(workspace: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--short", "--branch"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: sanitizedEnvironment(),
        timeout: 3_000,
        maxBuffer: 1_000_000,
      },
    );
    const lines = stdout.trimEnd().split(/\r?\n/);
    const branchLine = lines[0]?.startsWith("## ")
      ? lines.shift()!.slice(3)
      : "unbekannt";
    const branch = branchLine.split("...")[0]?.split(" ")[0] || "unbekannt";
    const changes = lines.filter(Boolean).length;
    return `${basename(workspace)} · Git ${branch} · ${
      changes ? `${changes} Änderung${changes === 1 ? "" : "en"}` : "sauber"
    }`;
  } catch {
    return `${basename(workspace)} · kein Git-Repository`;
  }
}

async function loadModelSnapshot(
  openRouter: OpenRouterService,
  modelId: string,
): Promise<{ model: ModelInfo | null; details: string }> {
  try {
    const models = await openRouter.listModels(modelId, true);
    const model = models.find((candidate) => candidate.id === modelId);
    return {
      model: model ?? null,
      details: model
        ? summarizeModel(model)
        : "dynamische OpenRouter-Route",
    };
  } catch {
    return {
      model: null,
      details: "Modellmetadaten momentan nicht verfügbar",
    };
  }
}

function summarizeModel(model: ModelInfo): string {
  const capabilities = [
    model.supportedParameters.includes("tools") ? "Tools" : "",
    model.supportedParameters.includes("reasoning") ? "Reasoning" : "",
    model.inputModalities.includes("image") ? "Bilder" : "",
    model.inputModalities.includes("audio") ? "Audio" : "",
  ].filter(Boolean);
  const price =
    model.promptPrice < 0 || model.completionPrice < 0
      ? "Preis dynamisch"
      : model.promptPrice === 0 && model.completionPrice === 0
        ? "kostenlos"
        : `In ${pricePerMillion(model.promptPrice)} · Out ${pricePerMillion(model.completionPrice)}`;
  return [
    `Kontext ${compactTokens(model.contextLength)}`,
    price,
    capabilities.length ? capabilities.join(", ") : "Text",
  ].join(" · ");
}

function pricePerMillion(value: number): string {
  return `$${(value * 1_000_000).toFixed(value * 1_000_000 < 0.1 ? 3 : 2)}/M`;
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1_000) {
    return `${Number((value / 1_000).toFixed(1))}K`;
  }
  return String(value);
}

function isPromptExit(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "ExitPromptError" ||
    error.message.includes("force closed")
  );
}

void main().catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
