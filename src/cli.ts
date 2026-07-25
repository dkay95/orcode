#!/usr/bin/env node

import { input, confirm, select } from "@inquirer/prompts";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  AgentRunError,
  OrcodeAgent,
  assertSpendAvailable,
  isAbortError,
  type AgentRunOutcome,
  type AgentRunResult,
} from "./agent.js";
import {
  attachmentPromptSummary,
  formatBytes,
  inspectImageAttachment,
  validateImageAttachmentSet,
  type ImageAttachment,
} from "./attachments.js";
import { ApprovalManager } from "./approval.js";
import { RuleStore } from "./rules.js";
import { createSshSession, type SshSession } from "./ssh.js";
import {
  createPlainCommandOutput,
  handleSlashCommand,
  printBalance,
  promptForValidKey,
  isTextGenerationModel,
  rankModels,
  shouldReplaceCredential,
  validateAndStoreInferenceKey,
  validateAndStoreManagementKey,
  type CommandContext,
  type CommandOutput,
} from "./commands.js";
import {
  consumeConfigWarning,
  isApprovalMode,
  isCompressionMode,
  loadConfig,
  migrateAppHome,
  saveConfig,
  type OrcodeConfigWithBudget,
} from "./config.js";
import {
  CredentialStore,
  type CredentialKind,
} from "./credentials.js";
import { OpenRouterService } from "./openrouter.js";
import {
  buildResumePrompt,
  findInterruptedRun,
  formatInterruptedRunNotice,
  formatUndoOutcome,
  markRunReviewed,
  summarizeRun,
  undoInterruptedRun,
  type InterruptedRun,
  type RunSummary,
} from "./resume.js";
import {
  getReasoningSetting,
  reasoningChoiceValue,
  reasoningChoices,
  reasoningLabel,
  setReasoningSetting,
  validateReasoningSetting,
} from "./reasoning.js";
import {
  SessionStore,
  migrateLegacySession,
  type SaveOutcome,
} from "./session.js";
import {
  TerminalUi,
  UiExitError,
  runOutcomeLabel,
  sanitizeTerminalText,
  type DashboardState,
} from "./tui.js";
import type {
  AgentRunEvent,
  ApprovalMode,
  BalanceInfo,
  ChatSummary,
  ModelInfo,
} from "./types.js";
import { APPROVAL_MODES } from "./types.js";
import { approvalDescription } from "./approval.js";
import { transcribeAudio } from "./transcribe.js";
import {
  createAudioRecorders,
  deleteRecordedAudio,
  ensureVoiceConsent,
  selectAudioRecorder,
  type AudioRecorder,
  type RecordedAudio,
  type RecordingHandle,
  type RecordingStopReason,
} from "./voice.js";
import {
  catastrophicGuardNotice,
  pruneCheckpoints,
  sanitizedEnvironment,
} from "./workspace.js";
import { errorMessage, formatUsd } from "./utils.js";

const execFileAsync = promisify(execFile);

/**
 * K8: a "Bedienfehler" — bad CLI usage, caught by `main()`'s top-level
 * handler and reported with exit code 2. Distinct from a runtime failure
 * (network, model, tool), which is exit code 1.
 */
export class CliUsageError extends Error {}

export interface CliOptions {
  workspace: string;
  prompt?: string;
  model?: string;
  approval?: string;
  compression?: string;
  chatId?: string;
  newChat: boolean;
  continueChat: boolean;
  help: boolean;
  version: boolean;
  plain: boolean;
  /** K8: NDJSON run events on stdout, non-interactive, machine-readable. */
  json: boolean;
  /** Resume an interrupted run's context without asking (see src/resume.ts). */
  resume: boolean;
  /** Never mention an interrupted run this start. */
  noResume: boolean;
}

/**
 * Reads the version from package.json so it is stated in exactly one place.
 * Works from both src/ (tsx) and dist/ because both sit one level below the root.
 */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the placeholder below.
  }
  return "unbekannt";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.version) {
    process.stdout.write(`orcode ${readPackageVersion()}\n`);
    return;
  }
  if (options.help) {
    printUsage();
    return;
  }

  // A5: startup cleanup, best-effort — a failed prune must never block a run.
  void pruneCheckpoints().catch(() => undefined);

  const config = await loadConfig();
  // loadConfig never throws any more; a broken file is reported instead of
  // silently replaced by defaults.
  const configWarning = consumeConfigWarning();
  if (configWarning) {
    console.log(chalk.yellow(configWarning));
  }
  if (options.model) {
    config.mainModel = options.model;
  }
  if (options.approval) {
    if (!isApprovalMode(options.approval)) {
      throw new CliUsageError(`Ungültiger Approval-Modus: ${options.approval}`);
    }
    config.approvalMode = options.approval;
  }
  if (options.compression) {
    if (!isCompressionMode(options.compression)) {
      throw new CliUsageError(`Ungültiger Kompressor-Modus: ${options.compression}`);
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
  const ruleStore = await RuleStore.load();
  approvals.setRuleStore(ruleStore, workspace);
  const sshSession = createSshSession();
  let session: SessionStore;
  if (options.newChat || options.chatId) {
    // `SessionStore.open()` migrates on its own; the explicit start modes have
    // to ask for it, otherwise an old v1 chat stays invisible after `--new`.
    await migrateLegacySession(workspace);
    session = options.chatId
      ? await SessionStore.openById(workspace, options.chatId)
      : SessionStore.create(workspace);
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
  const agent = await OrcodeAgent.create({
    openRouter,
    approvals,
    session,
    config,
    workspace,
  });

  const useTui = Boolean(
    !options.prompt &&
    !options.plain &&
    !options.json &&
    process.stdin.isTTY &&
    process.stdout.isTTY,
  );
  // The dashboard sink is created once `ui` exists (inside `runDashboard`) and
  // overwrites this placeholder before any command output happens. In --json
  // mode stdout is reserved for the NDJSON event stream, so every
  // human-readable status line goes to stderr instead.
  const out = options.json ? createStderrCommandOutput() : createPlainCommandOutput();
  if (!useTui && !options.json) {
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
      out,
      ruleStore,
      sshSession,
      showChatPickerOnStart:
        !options.newChat && !options.continueChat && !options.chatId,
      initialKeyFallback:
        storedInferenceKey && environmentInferenceKey
          ? environmentInferenceKey
          : undefined,
      resumeFlag: options.resume,
      noResumeFlag: options.noResume,
    });
    return;
  }

  if (approvals.mode === "allow-all" && process.stdin.isTTY && !options.json) {
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
    out,
    storedInferenceKey && environmentInferenceKey
      ? {
          key: environmentInferenceKey,
          origin: "environment",
        }
      : undefined,
  );

  if (options.json) {
    const prompt = options.prompt ?? (!process.stdin.isTTY ? await readStdinPrompt() : "");
    if (!prompt.trim()) {
      throw new CliUsageError(
        "Kein Prompt: --json braucht -p/--prompt oder eine nicht-interaktive stdin.",
      );
    }
    // Human-readable, so it goes to stderr — stdout is reserved for the
    // NDJSON event stream in --json mode (see createStderrCommandOutput).
    const effectivePrompt = await applyInterruptedRunNonInteractive(
      session,
      options,
      out,
      prompt,
    );
    process.exitCode = await runNonInteractive(agent, effectivePrompt, { json: true });
    return;
  }

  if (options.prompt) {
    await printBalance(startupBalance, out);
    const effectivePrompt = await applyInterruptedRunNonInteractive(
      session,
      options,
      out,
      options.prompt,
    );
    process.exitCode = await runNonInteractive(agent, effectivePrompt, { json: false });
    return;
  }

  await printBalance(startupBalance, out);
  await runPlainLoop(
    {
      workspace,
      config,
      approvals,
      openRouter,
      session,
      agent,
      credentials,
      out,
      ruleStore,
      sshSession,
    },
    options,
  );
}

interface RuntimeContext {
  workspace: string;
  config: OrcodeConfigWithBudget;
  approvals: ApprovalManager;
  openRouter: OpenRouterService;
  session: SessionStore;
  agent: OrcodeAgent;
  credentials: CredentialStore;
  out: CommandOutput;
  ruleStore: RuleStore;
  /** `/ssh`'s remembered target — read by the dashboard header, mutated by `sshCommand` in commands.ts. */
  sshSession: SshSession;
}

async function runPlainLoop(
  context: RuntimeContext,
  resumeOptions: Pick<CliOptions, "resume" | "noResume">,
): Promise<void> {
  console.log(chalk.dim("Schreibe eine Aufgabe oder /help. Ctrl+C beendet.\n"));
  // Set once, if the interrupted-run flow below resolves to "resume": the
  // resume context is prepended to the very next message the user actually
  // sends, then cleared — never sent on its own, never repeated.
  let pendingSeed = await checkInterruptedRunPlain(context, resumeOptions);
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
      const effective = pendingSeed ? `${pendingSeed}\n\n${trimmed}` : trimmed;
      pendingSeed = undefined;
      const result = await context.agent.run(effective);
      printRunFooter(result);
    } catch (error) {
      console.error(chalk.red(context.openRouter.safeMessage(error)));
      if (error instanceof AgentRunError) {
        // The fragment is already in the chat file; name what it cost.
        printRunFooter(error.result);
      }
      if (
        !context.openRouter.hasKey ||
        shouldReplaceCredential(error)
      ) {
        await printBalance(
          await promptForValidKey(
            context.openRouter,
            context.credentials,
            context.out,
          ),
          context.out,
        );
      }
    }
  }

  await context.session.save();
  console.log("Bis bald.");
}

// ---------------------------------------------------------------------------
// Interrupted-run detection at startup (src/resume.ts)
//
// Honesty constraint (see resume.ts's module doc): a real "continue mid-run"
// is impossible, since the SDK state of an interrupted run was deliberately
// never committed. What all three call sites below offer instead is a new
// run seeded with a factual summary of what happened — and only ever after
// the user explicitly says so. `--no-resume` skips the check outright;
// without either flag, an interactive session asks and a non-interactive one
// (`-p`/`--json`) only reports, never acts, never blocks.
// ---------------------------------------------------------------------------

type ResumeChoice = "resume" | "discard" | "undo" | null;

/**
 * Executes one already-made decision. Shared by every call site so the
 * *effect* of each choice — reuse `ChangeJournal.undoLastRun` for "undo" via
 * `undoInterruptedRun`, mark the run reviewed so it is not reported again —
 * is defined in exactly one place. `null` ("später entscheiden" / Escape /
 * Ctrl+C) does nothing at all, not even marking the run reviewed, so it is
 * reported again next start.
 */
async function applyResumeChoice(
  choice: ResumeChoice,
  context: RuntimeContext,
  run: InterruptedRun,
  summary: RunSummary,
  report: (text: string) => void,
): Promise<string | undefined> {
  if (choice === null) {
    return undefined;
  }
  if (choice === "discard") {
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    report("Verworfen. Die bisherigen Dateiänderungen dieses Laufs bleiben unverändert.");
    return undefined;
  }
  if (choice === "undo") {
    const outcome = await undoInterruptedRun(
      context.agent.journal,
      context.agent.guard,
      context.approvals,
      run,
    );
    await markRunReviewed(context.session.appHome, context.session.data.id, run);
    report(formatUndoOutcome(outcome));
    return undefined;
  }
  await markRunReviewed(context.session.appHome, context.session.data.id, run);
  return buildResumePrompt(summary);
}

/** Plain (`--plain` or non-TTY-fallback) loop: asks via `@inquirer/prompts`' `select`, defaulting to "später entscheiden". */
async function askResumeChoicePlain(): Promise<ResumeChoice> {
  try {
    return await select<ResumeChoice>({
      message: "Was tun mit dem abgebrochenen Lauf?",
      choices: [
        {
          name: "Später entscheiden (nichts verändern, beim nächsten Start erneut fragen)",
          value: null,
        },
        {
          name: "Fortsetzen (Zusammenfassung wird deiner nächsten Nachricht vorangestellt)",
          value: "resume",
        },
        {
          name: "Verwerfen (nicht mehr fragen, nichts wird zurückgenommen)",
          value: "discard",
        },
        { name: "Dateiänderungen dieses Laufs zurücknehmen (wie /undo)", value: "undo" },
      ],
      default: null,
    });
  } catch (error) {
    if (isPromptExit(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Runs the interrupted-run check for the plain (non-TUI) interactive loop.
 * Returns text to prepend to the user's next message when they chose to
 * resume, `undefined` otherwise. Never blocks and never acts without an
 * explicit choice from the user (`--no-resume` skips entirely; `--resume`
 * still prints what it is doing, since silence would be its own kind of
 * surprise).
 */
async function checkInterruptedRunPlain(
  context: RuntimeContext,
  options: Pick<CliOptions, "resume" | "noResume">,
): Promise<string | undefined> {
  if (options.noResume) {
    return undefined;
  }
  const run = await findInterruptedRun(context.session.appHome, context.session.data.id);
  if (!run) {
    return undefined;
  }
  const summary = summarizeRun(run.events);
  const notice = formatInterruptedRunNotice(summary, run.fileDrift);
  if (options.resume) {
    console.log(chalk.dim(notice));
    console.log(chalk.dim("Wird ohne Rückfrage fortgesetzt (--resume)."));
    return applyResumeChoice("resume", context, run, summary, (text) =>
      console.log(chalk.dim(text)),
    );
  }
  console.log(chalk.yellow(notice));
  const choice = await askResumeChoicePlain();
  return applyResumeChoice(choice, context, run, summary, (text) => console.log(chalk.dim(text)));
}

/**
 * TUI variant of the same check: shows the notice as a system message and,
 * without `--resume`, offers the three-way choice through `ui.pickChoice`
 * (Escape resolves to `null`, i.e. "später entscheiden" — same safe default
 * as everywhere else). A "resume" choice lands in the input line via
 * `insertInputText` — visible, editable, never auto-sent.
 */
async function checkInterruptedRunTui(
  ui: TerminalUi,
  context: RuntimeContext & { resumeFlag?: boolean; noResumeFlag?: boolean },
): Promise<string | undefined> {
  if (context.noResumeFlag) {
    return undefined;
  }
  const run = await findInterruptedRun(context.session.appHome, context.session.data.id);
  if (!run) {
    return undefined;
  }
  const summary = summarizeRun(run.events);
  const notice = formatInterruptedRunNotice(summary, run.fileDrift);
  const report = (text: string) => ui.addMessage("system", text, "Wiederaufnahme");

  if (context.resumeFlag) {
    report(`${notice}\nWird ohne Rückfrage fortgesetzt (--resume).`);
    return applyResumeChoice("resume", context, run, summary, report);
  }

  report(notice);
  const picked = await ui.pickChoice(
    "Abgebrochener Lauf",
    [
      {
        value: "later",
        label: "Später entscheiden",
        description: "Nichts wird verändert; die Meldung erscheint beim nächsten Start erneut.",
      },
      {
        value: "resume",
        label: "Fortsetzen",
        description:
          "Zusammenfassung wird in die Eingabezeile gelegt — du entscheidest, ob und wann du sie abschickst.",
      },
      {
        value: "discard",
        label: "Verwerfen",
        description: "Nichts wird zurückgenommen; nicht mehr melden.",
      },
      {
        value: "undo",
        label: "Änderungen zurücknehmen",
        description: "Macht die Dateiänderungen dieses Laufs rückgängig (wie /undo).",
      },
    ],
    "later",
    "later",
  );
  const choice: ResumeChoice =
    picked && picked.value !== "later" ? (picked.value as "resume" | "discard" | "undo") : null;
  return applyResumeChoice(choice, context, run, summary, report);
}

/**
 * Non-interactive (`-p`/`--json`): only ever acts on an explicit `--resume`
 * (combining the resume context with the actual prompt) or `--no-resume`
 * (silence). Without either flag the safe default applies — report and do
 * nothing, since there is no one to ask and a non-interactive run must never
 * block on input.
 */
async function applyInterruptedRunNonInteractive(
  session: SessionStore,
  options: Pick<CliOptions, "resume" | "noResume">,
  out: CommandOutput,
  prompt: string,
): Promise<string> {
  if (options.noResume) {
    return prompt;
  }
  const run = await findInterruptedRun(session.appHome, session.data.id);
  if (!run) {
    return prompt;
  }
  const summary = summarizeRun(run.events);
  const notice = formatInterruptedRunNotice(summary, run.fileDrift);
  if (!options.resume) {
    out.text(
      `${notice}\nNicht interaktiv, kein --resume/--no-resume: Es wird nichts verändert. ` +
        "Mit --resume automatisch übernehmen, mit --no-resume nicht mehr melden.",
    );
    return prompt;
  }
  out.text(`${notice}\nWird ohne Rückfrage fortgesetzt (--resume).`);
  await markRunReviewed(session.appHome, session.data.id, run);
  return `${buildResumePrompt(summary)}\n\n${prompt}`;
}

/**
 * Collects everything written during one command instead of writing it
 * immediately — the dashboard renders the whole result as a single block once
 * the command has finished (`flush`), which is what `captureConsole` used to
 * do by monkey-patching `console.log`/`console.error` globally.
 */
class BufferedCommandOutput implements CommandOutput {
  #lines: string[] = [];
  #level: "info" | "error" = "info";

  text(value: string): void {
    this.#lines.push(value);
  }

  error(value: string, hint?: string): void {
    this.#level = "error";
    this.#lines.push(hint ? `${value}\n${hint}` : value);
  }

  flush(): { output: string; level: "info" | "error" } {
    const output = sanitizeTerminalText(this.#lines.join("\n")).trim();
    const level = this.#level;
    this.#lines = [];
    this.#level = "info";
    return { output, level };
  }
}

async function runDashboard(
  context: RuntimeContext & {
    initialKeyFallback?: string;
    showChatPickerOnStart?: boolean;
    resumeFlag?: boolean;
    noResumeFlag?: boolean;
  },
): Promise<void> {
  let balance: BalanceInfo | null = null;
  let balanceLabel = "wird geprüft …";
  let resolvedModel = "";
  let projectStatus = `${basename(context.workspace)} · Workspace wird geprüft …`;
  let modelDetails = "Modellmetadaten werden geladen …";
  let currentModelInfo: ModelInfo | null = null;
  let pendingImages: ImageAttachment[] = [];
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
      sshHost: context.sshSession.active ?? undefined,
    };
  });
  const dashboardOut = new BufferedCommandOutput();
  context.out = dashboardOut;
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
      if (!keep.accepted) {
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

    // Checked here (after a possible startup chat switch above, so it looks
    // at whichever chat is actually open) rather than before `runDashboard`
    // is even called.
    const seed = await checkInterruptedRunTui(ui, context);
    if (seed) {
      ui.insertInputText(seed);
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
      let submittedImages: ImageAttachment[] = [];
      try {
        if (trimmed.startsWith("/")) {
          ui.setStatus("Befehl wird ausgeführt");
          const modelBefore = context.config.mainModel;
          const completedCommand = commandName(trimmed);
          const commandArgs = commandArguments(trimmed);
          const sessionBefore = context.session;

          if (
            completedCommand === "image" ||
            completedCommand === "attach"
          ) {
            const action = commandTail(trimmed);
            if (action.toLowerCase() === "clear") {
              pendingImages = [];
              ui.setImageAttachments([]);
              ui.addMessage(
                "system",
                "Alle ausstehenden Bildanhänge wurden entfernt.",
                "/image",
              );
            } else if (action.toLowerCase() === "list") {
              ui.addMessage(
                "system",
                pendingImages.length
                  ? attachmentPromptSummary(pendingImages)
                  : "Keine Bilder für die nächste Nachricht angehängt.",
                "/image",
              );
            } else {
              const chosenPath =
                !action || action.toLowerCase() === "choose"
                  ? await chooseDashboardImage(ui)
                  : action;
              if (chosenPath) {
                const attachment = await inspectImageAttachment(
                  chosenPath,
                  context.workspace,
                );
                const withoutDuplicate = pendingImages.filter(
                  (candidate) => candidate.path !== attachment.path,
                );
                const next = [...withoutDuplicate, attachment];
                validateImageAttachmentSet(next);
                pendingImages = next;
                ui.setImageAttachments(pendingImages);
                ui.addMessage(
                  "system",
                  `${attachment.name} wurde für die nächste Nachricht angehängt.\n${attachment.mimeType} · ${formatBytes(attachment.sizeBytes)}`,
                  "/image",
                );
              } else {
                ui.addMessage(
                  "system",
                  "Bildauswahl abgebrochen.",
                  "/image",
                );
              }
            }
            ui.setStatus("Bereit", false);
            continue;
          }

          if (completedCommand === "whisper" || completedCommand === "voice") {
            await runVoiceCapture(ui, context);
            ui.setStatus("Bereit", false);
            continue;
          }

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
                accepted = (
                  await ui.confirmAction(
                    "allow-all aktivieren?",
                    `Dateiänderungen und Shell-Befehle laufen ohne weitere Rückfrage. ${catastrophicGuardNotice()}`,
                  )
                ).accepted;
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
            const { accepted } = await ui.confirmAction(
              "Gespräch und Sitzungskosten zurücksetzen?",
              "Der gespeicherte Chat-Kontext und die Kostenstatistik dieses Workspaces werden gelöscht.",
            );
            if (accepted) {
              context.session.clear();
              context.agent.resetConversationMemory();
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
            const { accepted } = await ui.confirmAction(
              "allow-all aktivieren?",
              `Dateiänderungen und Shell-Befehle werden dann ohne weitere Nachfrage ausgeführt. ${catastrophicGuardNotice()}`,
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

          const outcome = await handleSlashCommand(trimmed, context);
          const captured = dashboardOut.flush();
          if (context.session !== sessionBefore) {
            startingSessionCost = context.session.data.costs.totalUsd;
            ui.loadTurns(context.session.recentTurns(40));
            pendingImages = [];
            ui.setImageAttachments([]);
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
          if (outcome === "exit") {
            break;
          }
          ui.setStatus("Bereit", false);
          continue;
        }

        if (pendingImages.length) {
          if (!currentModelInfo) {
            const snapshot = await loadModelSnapshot(
              context.openRouter,
              context.config.mainModel,
            );
            currentModelInfo = snapshot.model;
            modelDetails = snapshot.details;
          }
          if (
            currentModelInfo &&
            !currentModelInfo.inputModalities.includes("image")
          ) {
            ui.addMessage(
              "error",
              `Das aktive Modell ${context.config.mainModel} unterstützt laut OpenRouter keine Bilder. Wähle mit /model ein Modell mit „Bilder“-Fähigkeit; die Anhänge bleiben erhalten.`,
              "Bilder",
            );
            ui.setStatus("Bereit", false);
            continue;
          }
        }
        submittedImages = pendingImages.map((attachment) => ({
          ...attachment,
        }));
        pendingImages = [];
        ui.setImageAttachments([]);
        const imageSummary = attachmentPromptSummary(submittedImages);
        ui.addMessage(
          "user",
          imageSummary ? `${trimmed}\n\n🖼 ${imageSummary}` : trimmed,
        );
        ui.beginAssistant(context.config.mainModel);
        runController = new AbortController();
        ui.setCancelHandler(() => {
          runController?.abort(new Error("Der aktuelle Lauf wurde vom Benutzer abgebrochen."));
        });
        const result = await context.agent.run(
          trimmed,
          {
            onStatus: (status) => ui.setStatus(status),
            onText: (delta) => ui.appendAssistant(delta),
            onEvent: (event) => {
              ui.handleRunEvent(event);
              // A7: the context-fill header segment is fed from outside —
              // model-end is the only event carrying a fresh inputTokens
              // measurement, ModelInfo.contextLength comes from the model
              // picker's last snapshot.
              if (event.type === "model-end" && currentModelInfo?.contextLength) {
                ui.setContextPercent(
                  (event.inputTokens / currentModelInfo.contextLength) * 100,
                );
              }
            },
            signal: runController.signal,
          },
          submittedImages,
        );
        submittedImages = [];
        ui.setCancelHandler();
        resolvedModel = result.resolvedModel;
        ui.finishAssistant(result.text);
        ui.setSuggestedReplies(result.suggestions);
        for (const notice of result.notices) {
          ui.addMessage("system", notice, "Hinweis");
        }
        ui.addMessage(
          "system",
          `${runResultLabel(result.outcome)} · ${formatRunCost(result)} · ${formatRouting(result.selectedModel, result.resolvedModel)}`,
        );
        void inspectWorkspace(context.workspace).then((nextProjectStatus) => {
          projectStatus = nextProjectStatus;
          ui.refresh();
        });
      } catch (error) {
        const partial = error instanceof AgentRunError ? error.result : null;
        const cancelled =
          error instanceof AgentRunError
            ? error.outcome === "cancelled"
            : Boolean(runController?.signal.aborted) ||
              isAbortError(error);
        ui.setCancelHandler();
        // The fragment is already persisted; discarding it in the UI would only
        // hide what the model actually said before it stopped.
        ui.finishAssistant(partial?.text);
        if (submittedImages.length) {
          pendingImages = [...submittedImages, ...pendingImages];
          validateImageAttachmentSet(pendingImages);
          ui.setImageAttachments(pendingImages);
        }
        for (const notice of partial?.notices ?? []) {
          ui.addMessage("system", notice, "Hinweis");
        }
        ui.addMessage(
          cancelled ? "system" : "error",
          cancelled
            ? "Lauf abgebrochen. Bereits ausgeführte Tool-Aktionen wurden nicht automatisch zurückgenommen; der Teiltext wurde gespeichert."
            : context.openRouter.safeMessage(error),
        );
        if (partial && partial.costUsd > 0) {
          ui.addMessage(
            "system",
            `${runResultLabel(partial.outcome)} · ${formatRunCost(partial)}`,
          );
        }
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
  await saveDashboardSessionPreferences(context, ui);
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
  // Reuse the agent: rebuilding it dropped the cached model resolution, the
  // compressor price cache and the undo journal on every chat switch.
  context.agent.setSession(next);
  await saveDashboardSessionPreferences(context, ui);
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
  ui?: TerminalUi,
): Promise<void> {
  context.session.setPreferences(
    context.config.mainModel,
    getReasoningSetting(context.config),
  );
  reportSaveOutcome(await context.session.save(), ui);
}

/**
 * A second orcode window writing the same chat is resolved by a merge, not
 * by a silent overwrite — but the user should learn that it happened.
 */
function reportSaveOutcome(outcome: SaveOutcome, ui?: TerminalUi): void {
  if (!outcome.merged && !outcome.conflictBackupPath) {
    return;
  }
  const lines = [
    outcome.merged
      ? "Chat wurde mit den Änderungen einer zweiten orcode-Instanz zusammengeführt."
      : "",
    outcome.conflictBackupPath
      ? `Eine unlesbare Chat-Datei wurde gesichert: ${outcome.conflictBackupPath}`
      : "",
  ].filter(Boolean);
  const message = lines.join("\n");
  if (ui) {
    ui.addMessage("system", message, "Chat");
  } else {
    console.log(chalk.yellow(message));
  }
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    workspace: process.cwd(),
    newChat: false,
    continueChat: false,
    help: false,
    version: false,
    plain: false,
    json: false,
    resume: false,
    noResume: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--version" || argument === "-v") {
      options.version = true;
    } else if (argument === "--plain") {
      options.plain = true;
    } else if (argument === "--json") {
      options.json = true;
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
    } else if (argument === "--resume") {
      options.resume = true;
    } else if (argument === "--no-resume") {
      options.noResume = true;
    } else if (argument === "--chat") {
      options.chatId = requireValue(args, ++index, argument);
    } else if (argument.startsWith("-")) {
      throw new CliUsageError(`Unbekannte Option: ${argument}`);
    } else {
      // K8: a bare positional argument used to be silently absorbed into the
      // prompt — that turns a typo ("orcode status") into an unnoticed,
      // paid run. It is rejected instead, with a pointer to -p/--prompt.
      throw new CliUsageError(
        `Unerwartetes Argument „${argument}“. Ein Prompt braucht -p/--prompt "…" (oder --json und stdin).`,
      );
    }
  }
  const chatModes = [
    options.newChat,
    options.continueChat,
    Boolean(options.chatId),
  ].filter(Boolean).length;
  if (chatModes > 1) {
    throw new CliUsageError("--new, --continue und --chat können nicht kombiniert werden.");
  }
  if (options.resume && options.noResume) {
    throw new CliUsageError("--resume und --no-resume können nicht kombiniert werden.");
  }
  return options;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) {
    throw new CliUsageError(`${option} benötigt einen Wert.`);
  }
  return value;
}

function printBanner(workspace: string, model: string): void {
  console.log(chalk.bold.cyan("\norcode 0.3"));
  console.log(`${chalk.dim("Workspace")} ${workspace}`);
  console.log(`${chalk.dim("Main")}      ${model}`);
}

function printUsage(): void {
  console.log(`
orcode – lokaler Coding-Agent über OpenRouter

Verwendung:
  orcode [optionen] -p "aufgabe"
  orcode -C /pfad/zum/projekt

Ein bloßes Positionsargument (z. B. „orcode status") wird abgelehnt —
das wäre sonst ein stiller, kostenpflichtiger Lauf. Nutze -p/--prompt.

Optionen:
  -C, --cwd <pfad>          Arbeitsverzeichnis
  -p, --prompt <text>       Einmaliger nicht-interaktiver Lauf
  -m, --model <id>          Main-Modell für diesen Start
  -a, --approval <modus>    read-only | ask | auto-edit | allow-all
      --compress <modus>    off | auto | always
      --new                 Direkt einen neuen Chat beginnen
      --continue            Zuletzt verwendeten Chat fortsetzen
      --chat <id>           Einen bestimmten Chat öffnen
      --resume              Abgebrochenen vorherigen Lauf ohne Rückfrage als
                             Kontext für den nächsten Lauf übernehmen
      --no-resume           Abgebrochenen vorherigen Lauf bei diesem Start
                             nicht melden
      --plain               Klassische Ausgabe ohne Fullscreen-TUI
      --json                NDJSON-Ereignisstrom auf stdout; Prompt aus -p
                             oder, wenn stdin kein TTY ist, aus stdin
  -h, --help                Hilfe
  -v, --version             Version anzeigen

Exit-Codes: 0 erfolgreich · 1 Laufzeitfehler · 2 Bedienfehler ·
3 unverifiziert · 124 Schritt-/Kostenlimit erreicht.

Der API-Key wird ausschließlich über OPENROUTER_API_KEY oder die verdeckte
Eingabe beim Start angenommen und nach erfolgreicher Prüfung sicher im
System-Schlüsselbund gespeichert. Ein --key-Argument gibt es absichtlich nicht.
`);
}

/** K8: reads the whole of stdin as the prompt for `--json` when it is a pipe, not a TTY. */
async function readStdinPrompt(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** K8: same shape as `createPlainCommandOutput`, but never writes to stdout — for `--json`. */
function createStderrCommandOutput(): CommandOutput {
  return {
    text(value: string): void {
      console.error(value);
    },
    error(value: string, hint?: string): void {
      console.error(chalk.red(value));
      if (hint) {
        console.error(chalk.dim(hint));
      }
    },
  };
}

/**
 * K8 exit-code matrix: 0 erfolgreich · 1 Laufzeitfehler · 3 unverifiziert ·
 * 124 Schritt-/Kostenlimit. (2 Bedienfehler is thrown as `CliUsageError`
 * before any run starts, see the top-level `catch` below; `cancelled` is not
 * one of the five documented codes and uses the conventional SIGINT code.)
 */
export function runOutcomeExitCode(outcome: AgentRunOutcome): number {
  switch (outcome) {
    case "completed":
      return 0;
    case "step-limit":
    case "cost-limit":
      return 124;
    case "cancelled":
      return 130;
    case "error":
      return 1;
    default:
      // Forward-compatible: once `AgentRunOutcome` grows A4's "unverified"
      // outcome, it lands on exit 3 without another edit here.
      return (outcome as string) === "unverified" ? 3 : 1;
  }
}

/**
 * Runs one prompt to completion outside the TUI/plain-loop, either printing
 * the human footer or streaming NDJSON run events (K8), and returns the exit
 * code for that run.
 */
async function runNonInteractive(
  agent: OrcodeAgent,
  prompt: string,
  options: { json: boolean },
): Promise<number> {
  try {
    const result = await agent.run(prompt, {
      onEvent: options.json
        ? (event: AgentRunEvent) => {
            process.stdout.write(`${JSON.stringify(event)}\n`);
          }
        : undefined,
    });
    if (!options.json) {
      printRunFooter(result);
    }
    return runOutcomeExitCode(result.outcome);
  } catch (error) {
    // `agent.run` already emitted its `run-end` event on this path (K8
    // testkriterium 3: the last NDJSON line is always `run-end`) before
    // rethrowing — nothing more to write to stdout here.
    if (!options.json) {
      console.error(chalk.red(errorMessage(error)));
    }
    if (error instanceof AgentRunError) {
      return runOutcomeExitCode(error.outcome);
    }
    return 1;
  }
}

function printRunFooter(result: AgentRunResult): void {
  for (const notice of result.notices) {
    console.log(chalk.yellow(notice));
  }
  console.log(
    chalk.dim(
      `${runResultLabel(result.outcome)} · Kosten dieses Laufs: ${formatRunCost(result)} · Schritte: ${result.modelSteps} · Modell: ${formatRouting(result.selectedModel, result.resolvedModel)}`,
    ),
  );
}

/** German label for an `AgentRunResult.outcome`. */
function runResultLabel(outcome: AgentRunOutcome): string {
  return runOutcomeLabel(outcome === "completed" ? "complete" : outcome);
}

function formatRunCost(result: AgentRunResult): string {
  return result.compressorCostUsd > 0
    ? `${formatUsd(result.costUsd)} (Main ${formatUsd(result.mainCostUsd)} · Kompressor ${formatUsd(result.compressorCostUsd)})`
    : formatUsd(result.costUsd);
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

function commandTail(raw: string): string {
  return raw.match(/^\/\S+(?:\s+([\s\S]*))?$/)?.[1]?.trim() ?? "";
}

function recordingLimitLabel(reason: RecordingStopReason): string {
  return reason === "duration-limit"
    ? "Zeitlimit (120s) erreicht"
    : "Größenlimit (25 MB) erreicht";
}

/**
 * `/whisper` (`/voice`): asks for one-time consent, picks a recording
 * provider for this machine, runs the record → stop/cancel → transcribe →
 * insert-into-input-line flow. Every failure is reported through
 * `ui.addMessage("error", …)` instead of throwing, so a broken microphone or
 * a rejected model never crashes the dashboard loop.
 */
async function runVoiceCapture(ui: TerminalUi, context: RuntimeContext): Promise<void> {
  const consented = await ensureVoiceConsent(
    context.config,
    async () => {
      const decision = await ui.confirmAction(
        "Mikrofonaufnahme an OpenRouter senden?",
        "orcode nimmt dein Mikrofon auf und schickt die Aufnahme zur Transkription an ein Modell auf OpenRouter. Diese Zustimmung wird gespeichert und danach nicht erneut abgefragt.",
      );
      return decision.accepted;
    },
    () => saveConfig(context.config),
  );
  if (!consented) {
    ui.addMessage("system", "Spracheingabe abgebrochen: keine Einwilligung erteilt.", "/whisper");
    return;
  }

  let recorder: AudioRecorder;
  try {
    recorder = await selectAudioRecorder(createAudioRecorders());
  } catch (error) {
    ui.addMessage("error", errorMessage(error), "/whisper");
    return;
  }

  let handle: RecordingHandle;
  try {
    handle = await recorder.start();
  } catch (error) {
    ui.addMessage("error", `Aufnahme konnte nicht gestartet werden: ${errorMessage(error)}`, "/whisper");
    return;
  }

  const startedAt = handle.startedAt;
  const tick = (): void => {
    const seconds = Math.floor((Date.now() - startedAt) / 1_000);
    ui.updateRecordingStatus(`Aufnahme läuft · ${seconds}s · Enter stoppt · Esc bricht ab`);
  };
  const timer = setInterval(tick, 1_000);

  type ControlOutcome =
    | { via: "user"; action: "stop" | "cancel" }
    | { via: "limit"; reason: RecordingStopReason; audio: RecordedAudio };
  let outcome: ControlOutcome;
  try {
    outcome = await Promise.race<ControlOutcome>([
      ui
        .awaitRecordingControl("Aufnahme läuft · 0s · Enter stoppt · Esc bricht ab")
        .then((action) => ({ via: "user", action })),
      handle.autoStopped.then(({ reason, audio }) => ({ via: "limit", reason, audio })),
    ]);
  } finally {
    clearInterval(timer);
  }

  if (outcome.via === "limit") {
    // The keypress promise above is still pending — this ends "recording"
    // mode as if Enter had been pressed, without signalling the recorder
    // again (it already stopped itself).
    ui.triggerRecordingControl("stop");
    ui.addMessage(
      "system",
      `Aufnahme automatisch beendet: ${recordingLimitLabel(outcome.reason)}.`,
      "/whisper",
    );
    await transcribeAndInsert(ui, context, outcome.audio);
    return;
  }

  if (outcome.action === "cancel") {
    await handle.cancel();
    ui.addMessage("system", "Aufnahme abgebrochen.", "/whisper");
    return;
  }

  let audio: RecordedAudio;
  try {
    audio = await handle.stop();
  } catch (error) {
    ui.addMessage("error", errorMessage(error), "/whisper");
    return;
  }
  await transcribeAndInsert(ui, context, audio);
}

/** Sends the recording to `config.transcriptionModel`, inserts the result into the input line, and always deletes the temp file. */
async function transcribeAndInsert(
  ui: TerminalUi,
  context: RuntimeContext,
  audio: RecordedAudio,
): Promise<void> {
  if (audio.quiet) {
    ui.addMessage(
      "system",
      "Die Aufnahme wirkt sehr leise. Bringt die Erkennung nichts, versuche es lauter oder näher am Mikrofon erneut.",
      "/whisper",
    );
  }
  ui.setStatus("Aufnahme wird erkannt …");
  try {
    const result = await transcribeAudio({
      client: context.openRouter.client({ scope: "voice" }),
      openRouter: context.openRouter,
      modelId: context.config.transcriptionModel,
      audio,
    });
    if (!result.text) {
      ui.addMessage(
        "system",
        "Die Erkennung hat keinen Text geliefert — die Aufnahme war vermutlich zu leise oder unverständlich.",
        "/whisper",
      );
    } else {
      ui.insertInputText(result.text);
      ui.addMessage("system", `Erkannt: „${result.text}“ — steht jetzt in der Eingabezeile.`, "/whisper");
    }
    if (result.costUsd > 0) {
      context.session.addCost("voice", result.costUsd);
      await context.session.save();
    }
  } catch (error) {
    ui.addMessage("error", `Transkription fehlgeschlagen: ${context.openRouter.safeMessage(error)}`, "/whisper");
  } finally {
    await deleteRecordedAudio(audio);
  }
}

async function chooseDashboardImage(
  ui: TerminalUi,
): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new Error(
      "Automatische Dateiauswahl ist hier nicht verfügbar. Verwende /image <pfad>.",
    );
  }
  return ui.suspend(async () => {
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        [
          "-e",
          'POSIX path of (choose file with prompt "Bild für orcode auswählen" of type {"public.image"})',
        ],
        {
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 100_000,
        },
      );
      return stdout.trim() || null;
    } catch (error) {
      const message = errorMessage(error);
      if (/canceled|cancelled|-128/i.test(message)) {
        return null;
      }
      throw error;
    }
  });
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
    if (controller.signal.aborted || isAbortError(error)) {
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
      if (fallbackController.signal.aborted || isAbortError(error)) {
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
      if (controller.signal.aborted || isAbortError(error)) {
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
      if (controller.signal.aborted || isAbortError(error)) {
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
        } konnte nicht geladen werden: ${errorMessage(error)}`,
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

// Only run `main()` when this file is the actual process entrypoint (`node
// dist/cli.js` / the `orcode` bin) — not when a test imports pure helpers
// like `parseArgs` or `runOutcomeExitCode` from this module.
// `argv[1]` keeps the path the user typed, while the module URL is always
// symlink-resolved. The installed `orcode` bin *is* a symlink, so comparing
// the two verbatim never matches and `main()` would silently never run.
export function isEntrypoint(
  moduleUrl: string,
  argv1: string | undefined,
  resolvePath: (path: string) => string = realpathSync,
): boolean {
  if (!argv1) {
    return false;
  }
  if (moduleUrl === pathToFileURL(argv1).href) {
    return true;
  }
  try {
    return moduleUrl === pathToFileURL(resolvePath(argv1)).href;
  } catch {
    // A deleted or unreadable entrypoint is simply not this module.
    return false;
  }
}

const isMainModule = isEntrypoint(import.meta.url, process.argv[1]);

if (isMainModule) {
  void main().catch((error) => {
    console.error(chalk.red(errorMessage(error)));
    // K8: a usage error (bad option, bare positional argument, invalid
    // --approval/--compress) never even starts a run — it is a
    // "Bedienfehler", exit 2, distinct from a runtime failure (exit 1).
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  });
}
