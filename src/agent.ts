import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { maxCost, stepCountIs } from "@openrouter/agent";
import type { OpenRouter } from "@openrouter/agent";
import type { ApprovalManager } from "./approval.js";
import {
  compressContext,
  type CompressionResult,
  uncompressedContext,
} from "./compressor.js";
import { OpenRouterService } from "./openrouter.js";
import { SessionStore } from "./session.js";
import type {
  AgentRunEvent,
  BalanceInfo,
  RouterCodeConfig,
} from "./types.js";
import {
  buildReasoningRequest,
  getReasoningSetting,
} from "./reasoning.js";
import {
  ChangeJournal,
  WorkspaceGuard,
  createCodingTools,
} from "./workspace.js";
import {
  SDK_RETRY_CODES,
  formatConnectionEvent,
} from "./reconnect.js";
import { errorMessage, formatUsd, hasCode } from "./utils.js";

export interface AgentRunResult {
  text: string;
  suggestions: string[];
  costUsd: number;
  compression: CompressionResult;
  selectedModel: string;
  resolvedModel: string;
}

export interface AgentRunObserver {
  onStatus?: (status: string) => void;
  onText?: (delta: string, fullText: string) => void;
  onEvent?: (event: AgentRunEvent) => void;
  signal?: AbortSignal;
}

export class RouterCodeAgent {
  readonly journal = new ChangeJournal();
  readonly guard: WorkspaceGuard;
  #lastResolvedModel: string | null = null;

  private constructor(
    private readonly openRouter: OpenRouterService,
    private readonly approvals: ApprovalManager,
    private readonly session: SessionStore,
    private readonly config: RouterCodeConfig,
    guard: WorkspaceGuard,
  ) {
    this.guard = guard;
  }

  static async create(options: {
    openRouter: OpenRouterService;
    approvals: ApprovalManager;
    session: SessionStore;
    config: RouterCodeConfig;
    workspace: string;
  }): Promise<RouterCodeAgent> {
    return new RouterCodeAgent(
      options.openRouter,
      options.approvals,
      options.session,
      options.config,
      await WorkspaceGuard.create(options.workspace),
    );
  }

  async run(
    prompt: string,
    observer: AgentRunObserver = {},
  ): Promise<AgentRunResult> {
    const startedAt = Date.now();
    let toolCount = 0;
    observer.onEvent?.({
      type: "run-start",
      model: this.config.mainModel,
      maxSteps: this.config.maxSteps,
      timestamp: startedAt,
    });
    const stopListening = this.openRouter.onConnectionEvent((event) => {
      emitStatus(
        observer,
        formatConnectionEvent(event),
        event.phase === "restored" ? chalk.green : chalk.yellow,
      );
    });
    try {
      const result = await this.#run(prompt, observer, (count) => {
        toolCount = count;
      });
      observer.onEvent?.({
        type: "run-end",
        outcome: "complete",
        durationMs: Date.now() - startedAt,
        toolCount,
        timestamp: Date.now(),
      });
      return result;
    } catch (error) {
      observer.onEvent?.({
        type: "run-end",
        outcome: observer.signal?.aborted ? "cancelled" : "error",
        durationMs: Date.now() - startedAt,
        toolCount,
        timestamp: Date.now(),
      });
      throw error;
    } finally {
      stopListening();
    }
  }

  async #run(
    prompt: string,
    observer: AgentRunObserver,
    updateToolCount: (count: number) => void,
  ): Promise<AgentRunResult> {
    throwIfAborted(observer.signal);
    observer.onStatus?.("OpenRouter-Guthaben und Key-Limit prüfen");
    const balance = await this.openRouter.checkBalance(observer.signal);
    assertSpendAvailable(balance);
    throwIfAborted(observer.signal);

    const client = this.openRouter.client();
    let compression: CompressionResult;
    observer.onStatus?.("Kontext und Kompressor vorbereiten");
    try {
      compression = await compressContext(
        client,
        this.config,
        this.session,
        prompt,
        observer.signal,
      );
    } catch (error) {
      throwIfAborted(observer.signal);
      const raw = uncompressedContext(this.session, prompt);
      compression = {
        used: false,
        handoff: raw,
        costUsd: 0,
        originalChars: raw.length,
        compressedChars: raw.length,
      };
      emitStatus(
        observer,
        `Kompressor fehlgeschlagen; unkomprimierter Kontext wird verwendet: ${this.openRouter.safeMessage(error)}`,
        chalk.yellow,
      );
    }
    if (compression.used) {
      const percentage = compression.originalChars
        ? Math.round((1 - compression.compressedChars / compression.originalChars) * 100)
        : 0;
      emitStatus(
        observer,
        `Kompressor ${this.config.compressorModel}: ${compression.originalChars} → ${compression.compressedChars} Zeichen (${percentage}% kleiner), ${formatUsd(compression.costUsd)}`,
        chalk.dim,
      );
    }

    observer.onStatus?.(`${this.config.mainModel} arbeitet`);
    const instructions = await buildInstructions(
      this.guard.root,
      this.approvals.mode,
      this.config.maxCostUsd,
      this.config.mainModel,
      this.#lastResolvedModel,
    );
    const tools = createCodingTools(this.guard, this.approvals, this.journal);
    const reasoning = buildReasoningRequest(
      getReasoningSetting(this.config),
    );
    let observedCost = 0;
    let modelStep = 1;
    let toolSequence = 0;
    const pendingTools = new Map<
      string,
      Array<{
        id: string;
        number: number;
        input: Record<string, unknown>;
        startedAt: number;
      }>
    >();
    const activeToolIds = new Set<string>();
    const beginNextModelStep = () => {
      if (activeToolIds.size > 0) {
        return;
      }
      modelStep += 1;
      observer.onEvent?.({
        type: "model-start",
        model: this.config.mainModel,
        step: modelStep,
        timestamp: Date.now(),
      });
    };
    observer.onEvent?.({
      type: "model-start",
      model: this.config.mainModel,
      step: modelStep,
      timestamp: Date.now(),
    });
    const result = client.callModel(
      {
        model: this.config.mainModel,
        instructions,
        input: [
          `COMPRESSED OR RAW WORK CONTEXT:\n${compression.handoff}`,
          `AUTHORITATIVE CURRENT USER REQUEST:\n${prompt}`,
        ].join("\n\n"),
        ...(reasoning ? { reasoning } : {}),
        tools,
        stopWhen: [
          stepCountIs(this.config.maxSteps),
          maxCost(this.config.maxCostUsd),
        ],
        allowFinalResponse:
          "Tool execution has stopped. Summarize the verified outcome, any remaining blocker, and the most useful next step. Do not claim unverified success.",
        hooks: {
          PreToolUse: [
            {
              handler: ({ toolName, toolInput }) => {
                toolSequence += 1;
                updateToolCount(toolSequence);
                const pending = {
                  id: `tool-${toolSequence}`,
                  number: toolSequence,
                  input: toolInput,
                  startedAt: Date.now(),
                };
                const queue = pendingTools.get(toolName) ?? [];
                queue.push(pending);
                pendingTools.set(toolName, queue);
                activeToolIds.add(pending.id);
                observer.onEvent?.({
                  type: "tool-start",
                  id: pending.id,
                  number: pending.number,
                  name: toolName,
                  input: toolInput,
                  timestamp: pending.startedAt,
                });
              },
            },
          ],
          PostToolUse: [
            {
              handler: ({ toolName, toolInput, toolOutput, durationMs }) => {
                const pending = shiftPendingTool(
                  pendingTools,
                  toolName,
                  toolInput,
                );
                const id = pending?.id ?? `tool-${++toolSequence}`;
                const number = pending?.number ?? toolSequence;
                updateToolCount(toolSequence);
                activeToolIds.delete(id);
                observer.onEvent?.({
                  type: "tool-end",
                  id,
                  number,
                  name: toolName,
                  input: toolInput,
                  output: toolOutput,
                  durationMs,
                  timestamp: Date.now(),
                });
                beginNextModelStep();
              },
            },
          ],
          PostToolUseFailure: [
            {
              handler: ({ toolName, toolInput, error }) => {
                const pending = shiftPendingTool(
                  pendingTools,
                  toolName,
                  toolInput,
                );
                const id = pending?.id ?? `tool-${++toolSequence}`;
                const number = pending?.number ?? toolSequence;
                updateToolCount(toolSequence);
                activeToolIds.delete(id);
                observer.onEvent?.({
                  type: "tool-error",
                  id,
                  number,
                  name: toolName,
                  input: toolInput,
                  error: errorMessage(error),
                  durationMs: pending ? Date.now() - pending.startedAt : 0,
                  timestamp: Date.now(),
                });
                beginNextModelStep();
              },
            },
          ],
          PostModelCall: [
            {
              handler: async ({
                usage,
                model,
                durationMs,
                turnNumber,
              }) => {
                const callCost = usage?.cost ?? 0;
                observedCost += callCost;
                modelStep = Math.max(modelStep, turnNumber + 1);
                observer.onEvent?.({
                  type: "model-end",
                  model,
                  step: turnNumber + 1,
                  durationMs,
                  inputTokens: usage?.inputTokens ?? 0,
                  outputTokens: usage?.outputTokens ?? 0,
                  reasoningTokens: usage?.reasoningTokens ?? 0,
                  costUsd: callCost,
                  timestamp: Date.now(),
                });
                this.session.addCost("main", callCost);
                await this.session.save();
              },
            },
          ],
        },
      },
      {
        ...(observer.signal ? { signal: observer.signal } : {}),
        retryCodes: [...SDK_RETRY_CODES],
      },
    );

    let rawText = "";
    const suggestionStream = new SuggestedReplyStreamFilter();
    let reasoningStreamError: unknown;
    const reasoningHeartbeat = (async () => {
      try {
        for await (const delta of result.getReasoningStream()) {
          if (!delta) {
            continue;
          }
          observer.onEvent?.({
            type: "reasoning",
            model: this.config.mainModel,
            step: modelStep,
            delta,
            timestamp: Date.now(),
          });
        }
      } catch (error) {
        reasoningStreamError = error;
      }
    })();
    if (!observer.onText) {
      process.stdout.write("\n");
    }
    for await (const delta of result.getTextStream()) {
      rawText += delta;
      const visibleDelta = suggestionStream.push(delta);
      if (!visibleDelta) {
        continue;
      }
      if (observer.onText) {
        observer.onText(visibleDelta, suggestionStream.visibleText);
      } else {
        process.stdout.write(visibleDelta);
      }
    }
    const finalVisibleDelta = suggestionStream.finish();
    if (finalVisibleDelta) {
      if (observer.onText) {
        observer.onText(finalVisibleDelta, suggestionStream.visibleText);
      } else {
        process.stdout.write(finalVisibleDelta);
      }
    }
    await reasoningHeartbeat;
    if (reasoningStreamError) {
      throw reasoningStreamError;
    }
    const parsedAnswer = parseSuggestedReplies(rawText);
    if (!observer.onText && !parsedAnswer.text.endsWith("\n")) {
      process.stdout.write("\n");
    }
    const response = await result.getResponse();
    const costUsd = observedCost || response.usage?.cost || 0;
    const resolvedModel = response.model || this.config.mainModel;
    this.#lastResolvedModel = resolvedModel;
    if (observedCost === 0 && costUsd > 0) {
      this.session.addCost("main", costUsd);
    }

    this.session.addTurn("user", prompt);
    this.session.addTurn("assistant", parsedAnswer.text);
    await this.session.save();

    return {
      text: parsedAnswer.text,
      suggestions: parsedAnswer.suggestions,
      costUsd,
      compression,
      selectedModel: this.config.mainModel,
      resolvedModel,
    };
  }
}

function shiftPendingTool(
  pendingTools: Map<
    string,
    Array<{
      id: string;
      number: number;
      input: Record<string, unknown>;
      startedAt: number;
    }>
  >,
  toolName: string,
  toolInput: Record<string, unknown>,
):
  | {
      id: string;
      number: number;
      input: Record<string, unknown>;
      startedAt: number;
    }
  | undefined {
  const queue = pendingTools.get(toolName);
  if (!queue?.length) {
    return undefined;
  }
  const exactIndex = queue.findIndex(
    (pending) => JSON.stringify(pending.input) === JSON.stringify(toolInput),
  );
  const [pending] = queue.splice(exactIndex >= 0 ? exactIndex : 0, 1);
  if (!queue.length) {
    pendingTools.delete(toolName);
  }
  return pending;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Der aktuelle Lauf wurde abgebrochen.");
}

function emitStatus(
  observer: AgentRunObserver,
  message: string,
  style: (value: string) => string,
): void {
  if (observer.onStatus) {
    observer.onStatus(message);
  } else {
    console.log(style(message));
  }
}

export function assertSpendAvailable(balance: BalanceInfo): void {
  if (balance.credits && balance.credits.remaining <= 0) {
    throw new Error("Das OpenRouter-Kontoguthaben ist aufgebraucht.");
  }
  if (
    balance.key.limit !== null &&
    balance.key.limit !== undefined &&
    balance.key.limitRemaining !== null &&
    balance.key.limitRemaining !== undefined &&
    balance.key.limitRemaining <= 0
  ) {
    throw new Error("Das Ausgabenlimit dieses OpenRouter-Keys ist aufgebraucht.");
  }
  if (balance.key.expiresAt) {
    const expiresAt = Date.parse(balance.key.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      throw new Error("Der OpenRouter-Key ist abgelaufen.");
    }
  }
}

async function buildInstructions(
  workspace: string,
  approvalMode: string,
  maxCostUsd: number,
  selectedModel: string,
  lastResolvedModel: string | null,
): Promise<string> {
  const projectInstructions = await loadProjectInstructions(workspace);
  return [
    "You are RouterCode, a local coding agent.",
    ...modelIdentityInstructions(selectedModel, lastResolvedModel),
    `Your workspace root is ${workspace}.`,
    "Inspect relevant files before changing them.",
    "Use focused reads and searches. Prefer replace_text for small edits and write_file for new or complete files.",
    "Run relevant tests after edits. Use git_diff to review the result.",
    "Never expose secrets, API keys, tokens, or environment values.",
    "Do not access paths outside the workspace.",
    "Do not claim a command, test, or visible result succeeded unless its output verifies that.",
    `The active approval mode is ${approvalMode}. Permission rejection is authoritative; adapt without trying to bypass it.`,
    `The per-run main-model cost ceiling is $${maxCostUsd.toFixed(4)}.`,
    [
      "At the very end of every final user-facing answer, emit exactly one hidden quick-reply block in this format:",
      '<routercode_suggestions>["Kurze Antwort 1","Kurze Antwort 2"]</routercode_suggestions>',
      "Use the user's language. Provide 2 to 4 concise replies the user could send next, each at most 140 characters.",
      "Suggestions must be written from the user's perspective and should represent distinct useful next actions.",
      "Do not mention or explain this block, do not wrap it in Markdown, and emit it only after the complete visible answer.",
    ].join("\n"),
    projectInstructions ? `PROJECT INSTRUCTIONS:\n${projectInstructions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const SUGGESTIONS_OPEN = "<routercode_suggestions>";
const SUGGESTIONS_CLOSE = "</routercode_suggestions>";

export interface ParsedSuggestedReplies {
  text: string;
  suggestions: string[];
}

export function parseSuggestedReplies(value: string): ParsedSuggestedReplies {
  const lower = value.toLowerCase();
  const start = lower.lastIndexOf(SUGGESTIONS_OPEN);
  if (start < 0) {
    return {
      text: value.trim(),
      suggestions: [],
    };
  }
  const contentStart = start + SUGGESTIONS_OPEN.length;
  const end = lower.indexOf(SUGGESTIONS_CLOSE, contentStart);
  const visible = value.slice(0, start).trim();
  if (end < 0) {
    return {
      text: visible,
      suggestions: [],
    };
  }
  const trailing = value.slice(end + SUGGESTIONS_CLOSE.length).trim();
  if (trailing) {
    return {
      text: [visible, trailing].filter(Boolean).join("\n"),
      suggestions: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(contentStart, end));
  } catch {
    return {
      text: visible,
      suggestions: [],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      text: visible,
      suggestions: [],
    };
  }
  const suggestions: string[] = [];
  for (const candidate of parsed) {
    if (typeof candidate !== "string") {
      continue;
    }
    const clean = candidate.replace(/\s+/g, " ").trim().slice(0, 140);
    if (
      clean &&
      !suggestions.some(
        (suggestion) => suggestion.toLowerCase() === clean.toLowerCase(),
      )
    ) {
      suggestions.push(clean);
    }
    if (suggestions.length === 4) {
      break;
    }
  }
  return {
    text: visible,
    suggestions,
  };
}

export class SuggestedReplyStreamFilter {
  #pending = "";
  #hidden = false;
  #visibleText = "";

  get visibleText(): string {
    return this.#visibleText;
  }

  push(delta: string): string {
    if (!delta || this.#hidden) {
      return "";
    }
    const combined = this.#pending + delta;
    const markerIndex = combined.toLowerCase().indexOf(SUGGESTIONS_OPEN);
    if (markerIndex >= 0) {
      const visible = combined.slice(0, markerIndex);
      this.#pending = "";
      this.#hidden = true;
      this.#visibleText += visible;
      return visible;
    }
    const retainedLength = Math.min(
      combined.length,
      SUGGESTIONS_OPEN.length - 1,
    );
    const visibleLength = combined.length - retainedLength;
    const visible = combined.slice(0, visibleLength);
    this.#pending = combined.slice(visibleLength);
    this.#visibleText += visible;
    return visible;
  }

  finish(): string {
    if (this.#hidden || !this.#pending) {
      this.#pending = "";
      return "";
    }
    const visible = this.#pending;
    this.#pending = "";
    this.#visibleText += visible;
    return visible;
  }
}

export function modelIdentityInstructions(
  selectedModel: string,
  lastResolvedModel: string | null = null,
): string[] {
  const provider = selectedModel.includes("/")
    ? selectedModel.split("/")[0]
    : "unknown";
  return [
    "RouterCode is the user's independent local CLI project. It is not Codex, ChatGPT, Claude Code, or an OpenAI product.",
    "Never claim that RouterCode was built by OpenAI, Anthropic, Moonshot AI, or another model provider.",
    `The active model route for this turn is exactly "${selectedModel}" and requests are routed through OpenRouter.`,
    selectedModel === "openrouter/auto"
      ? "This is a dynamic OpenRouter route. If asked which model you are, say that this turn uses openrouter/auto and that the upstream model may vary; do not guess a specific model."
      : `The model provider namespace is "${provider}". If asked which model you are, answer: "RouterCode mit ${selectedModel} über OpenRouter."`,
    lastResolvedModel
      ? `The previous turn resolved to "${lastResolvedModel}". This is historical context, not proof of the current turn's upstream route.`
      : "",
  ].filter(Boolean);
}

async function loadProjectInstructions(workspace: string): Promise<string> {
  const sections: string[] = [];
  for (const name of ["AGENTS.md", "ROUTERCODE.md"]) {
    try {
      const content = await readFile(join(workspace, name), "utf8");
      sections.push(`${name}:\n${content.slice(0, 40_000)}`);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  return sections.join("\n\n");
}
