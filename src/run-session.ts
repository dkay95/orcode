/**
 * The one run-a-message orchestration, with no surface of its own.
 *
 * Until G1 this lived inline inside `runDashboard` (cli.ts) and spoke only
 * `TerminalUi`: the abort controller, the interjection/end-thinking wiring,
 * the honest setup gate, the image-capability checks, the observer literal,
 * the run-complete footer and the whole cancel/error path were ~150 lines of
 * closure-bound terminal calls. A second interactive surface (the GUI
 * sidecar, `gui-server.ts`) needs exactly those semantics and none of that
 * terminal — so the orchestration moved here against a port, and the
 * dashboard now calls it with `TerminalUi` as the port.
 *
 * Deliberately NOT a redesign. The body below is the dashboard's own code,
 * moved: same order, same wording, same honesty rules (a cancelled run is
 * never a success, an unspent prompt goes back to the composer, a partial
 * cost is still reported). `RunSessionSurface`'s method names are
 * `TerminalUi`'s method names precisely so the TUI adapter is the UI object
 * itself and no translation layer can drift.
 *
 * What stayed in `cli.ts`: everything that is bootstrap rather than run —
 * the model catalog helpers, the route/model binding assertion, the footer
 * composition. They arrive through `RunSessionDeps`, whose single
 * implementation is `defaultRunSessionDeps` (cli.ts), so there is one
 * mechanism per concept and no import cycle.
 */

import type { ImageAttachment } from "./attachments.js";
import { attachmentPromptSummary, validateImageAttachmentSet } from "./attachments.js";
import {
  AgentRunError,
  contextFillPercent,
  EndThinkingSignal,
  InterjectionQueue,
  isAbortError,
  type AgentRunResult,
  type AgentRunObserver,
  type OrcodeAgent,
} from "./agent.js";
import type { RouteIdentityV1 } from "./backends.js";
import type { OrcodeConfigWithBudget } from "./config.js";
import type { OpenRouterService } from "./openrouter.js";
import type { SetupHubResult, SetupSurface } from "./setup-surface/index.js";
import type { AgentRunEvent, ModelInfo } from "./types.js";
import type { CodexOperationJournal, CodexTurnExecutionInput } from "./codex-execution.js";

export async function runPreparedCodexSessionTurn(input: CodexTurnExecutionInput): Promise<CodexOperationJournal> {
  const { startCodexTurn } = await import("./codex-execution.js");
  return startCodexTurn(input);
}

/**
 * Everything the run orchestration says to a surface — and nothing else.
 *
 * Every member is a `TerminalUi` method with the same name and a compatible
 * signature, so `runDashboard` passes its `ui` directly. A surface that
 * cannot do one of these honestly (a headless server has no composer to
 * restore a draft into) still has to answer the call: silence is a decision
 * the surface makes, never one this module makes for it.
 */
export interface RunSessionSurface {
  /** Undefined clears the handler — the run is over and Esc must not abort a dead run. */
  setCancelHandler(handler?: () => void): void;
  setInterjectHandler(handler?: (text: string) => void): void;
  setEndThinkingHandler(handler?: () => void): void;
  setImageAttachments(attachments: readonly ImageAttachment[]): void;
  addMessage(
    role: "user" | "assistant" | "system" | "error",
    content: string,
    meta?: string,
  ): void;
  beginAssistant(model: string): void;
  appendAssistant(delta: string): void;
  /** `undefined` means "nothing streamed" — the surface decides what to show. */
  finishAssistant(fallback?: string): void;
  setStatus(status: string, busy?: boolean): void;
  setSuggestedReplies(replies: readonly string[]): void;
  setContextPercent(percent: number | undefined): void;
  handleRunEvent(event: AgentRunEvent): void;
  /** The typed text nothing consumed. Goes back where the owner can edit it. */
  restoreSubmittedDraft(text: string): void;
  /** A refused submission's text, handed back before anything ran. */
  insertInputText(text: string): void;
}

/**
 * The pieces of the interactive runtime context a run actually touches.
 *
 * Structural on purpose: `RuntimeContext`/`DashboardRunInput` (cli.ts) and
 * the GUI sidecar's own context both satisfy it without either importing
 * the other's shape.
 */
export interface RunSessionContext {
  config: OrcodeConfigWithBudget;
  agent: OrcodeAgent | null;
  readonly openRouter: Pick<OpenRouterService, "safeMessage" | "listModels">;
  readonly providerRuntime: {
    runWithReadyRoute<T>(
      run: (route: RouteIdentityV1) => Promise<T>,
      surface?: SetupSurface | "plain" | "fullscreen",
    ): Promise<T>;
    runSetup(surface: SetupSurface | "plain" | "fullscreen"): Promise<SetupHubResult>;
    ensureRunnableRoute(): RouteIdentityV1;
  };
  ensureAgentForPrompt(surface?: SetupSurface): Promise<OrcodeAgent>;
  /** Codex owns its tool loop; it must never be routed through the OpenRouter SDK. */
  runManagedCodexTurn?(
    route: RouteIdentityV1, text: string, observer: AgentRunObserver,
  ): Promise<AgentRunResult>;
}

/**
 * The cli.ts-owned behaviours a run needs. One implementation exists
 * (`defaultRunSessionDeps`, cli.ts); both surfaces pass that same object.
 */
export interface RunSessionDeps {
  /** cli.ts: a model that is not the resolved route's model may not run. */
  assertModelBoundToRoute(modelId: string, route: RouteIdentityV1): void;
  /** cli.ts: revalidates main/fallback/compressor against the live catalog. */
  ensureRunnableModelConfiguration(
    openRouter: Pick<OpenRouterService, "listModels">,
    config: OrcodeConfigWithBudget,
  ): Promise<{ main: ModelInfo | null; compressor: ModelInfo | null }>;
  /** cli.ts: one model's catalog entry, or an honest "not available". */
  loadModelSnapshot(
    openRouter: Pick<OpenRouterService, "listModels">,
    modelId: string,
  ): Promise<{ model: ModelInfo | null }>;
  /** cli.ts `dashboardRouteIsRunnable`: can a message run right now? */
  routeIsRunnable(runtime: RunSessionContext["providerRuntime"]): boolean;
  /** cli.ts: the run-complete line (outcome · cost · routing). */
  runFooter(result: AgentRunResult, config: OrcodeConfigWithBudget): string;
  /** cli.ts: the partial-cost line a failed or cancelled run still owes. */
  partialFooter(partial: AgentRunResult, config: OrcodeConfigWithBudget): string;
  /**
   * How a failed run is described to the surface.
   *
   * `openRouter.safeMessage` for the terminal, which is what it has always
   * been: `OpenRouterFailure.detail` is documented as the original technical
   * text with key material redacted, and the owner reading their own terminal
   * is exactly who it is for.
   *
   * The GUI overrides it. Controller ruling (fix round 2): on the WIRE the
   * boundary rule outranks TUI parity, because `detail` also carries request
   * ids and provider response bodies, and a run failure crosses as an
   * ordinary `transcript` frame that any client may render, log or forward.
   * The sidecar therefore uses the same detail-dropping renderer every other
   * outbound failure uses, and keeps the full text on stderr. The TUI's own
   * rendering is untouched.
   */
  describeRunFailure(
    openRouter: Pick<OpenRouterService, "safeMessage">,
    error: unknown,
  ): string;
}

/**
 * The per-submission state the surrounding loop's `catch` also reads.
 *
 * Held in an object rather than three `let`s because the failure half is a
 * separate exported function: the dashboard's `catch` covers command
 * dispatch as well as runs, so the two halves cannot be one closure without
 * changing what a failing command does.
 */
export interface RunTurnState {
  controller: AbortController | null;
  submittedImages: ImageAttachment[];
  /**
   * Flipped at the exact moment this submission becomes a real run (its
   * `user` block enters the transcript, right before the agent is bound).
   * Everything that can fail BEFORE that leaves the typed text unspent, so
   * the failure path hands it back instead of destroying it.
   */
  runStarted: boolean;
}

export function createRunTurnState(): RunTurnState {
  return { controller: null, submittedImages: [], runStarted: false };
}

/** The mutable chrome a run reads and writes on its way through. */
export interface RunSessionPorts {
  readAttachments(): ImageAttachment[];
  writeAttachments(next: ImageAttachment[]): void;
  readModelInfo(): ModelInfo | null;
  writeModelInfo(next: ModelInfo | null): void;
  setResolvedModel(model: string): void;
}

export interface RunSessionTurnInput {
  readonly surface: RunSessionSurface;
  readonly context: RunSessionContext;
  readonly deps: RunSessionDeps;
  readonly ports: RunSessionPorts;
  readonly state: RunTurnState;
  readonly setupSurface: SetupSurface;
  /** The owner's submitted text, already trimmed. */
  readonly text: string;
}

export type RunSessionTurnOutcome =
  /** The honest gate refused: no runnable provider and setup was declined. */
  | { readonly kind: "setup-declined" }
  | { readonly kind: "completed"; readonly result: AgentRunResult };

/**
 * Runs one submitted message. Throws exactly what the agent throws — the
 * caller's `catch` feeds it to {@link applyRunTurnFailure}, which is the
 * same handler a failing command goes through.
 */
export async function runSessionTurn(
  input: RunSessionTurnInput,
): Promise<RunSessionTurnOutcome> {
  const { surface, context, deps, ports, state, setupSurface, text } = input;
  // FIX-17: the honest gate. With the unsolicited launch modal gone, THIS is
  // where setup necessity is enforced — the moment the owner actually tries
  // to run a message without a runnable provider, setup is offered right
  // here. Declining costs nothing: the typed message goes back untouched
  // (the surface itself already posts its "Setup cancelled" notice).
  if (!deps.routeIsRunnable(context.providerRuntime)) {
    const setup = await context.providerRuntime.runSetup(setupSurface);
    if (setup.kind !== "ready") {
      surface.insertInputText(text);
      surface.setStatus("Provider setup is needed before a message can run", false);
      return { kind: "setup-declined" };
    }
  }
  const controller = new AbortController();
  state.controller = controller;
  surface.setCancelHandler(() => {
    state.controller?.abort(new Error("The current run was cancelled by the user."));
  });
  // Phase 3b, Parts B/C: fresh per run, mirroring `controller` — no
  // interjection or armed end-thinking state may leak from a previous run
  // into this one.
  const interjections = new InterjectionQueue();
  const endThinking = new EndThinkingSignal();
  surface.setInterjectHandler((interjection) => {
    interjections.enqueue(interjection);
  });
  surface.setEndThinkingHandler(() => {
    endThinking.trigger();
  });
  const result = await context.providerRuntime.runWithReadyRoute(async (route) => {
    if (route.backendId === "codex") {
      if (!context.runManagedCodexTurn) {
        throw new Error("Codex-Ausführung ist in diesem Startmodus nicht verfügbar.");
      }
      if (ports.readAttachments().length > 0) {
        throw new Error("Bilder sind für Codex in orcode noch nicht verfügbar. Die Anhänge bleiben erhalten.");
      }
      // No false controls: this provider manages reasoning and has no interjection bridge yet.
      surface.setInterjectHandler();
      surface.setEndThinkingHandler();
      ports.writeModelInfo(null);
      surface.setContextPercent(undefined);
      surface.addMessage("user", text);
      state.runStarted = true;
      surface.beginAssistant(route.canonicalModelId!);
      return context.runManagedCodexTurn(route, text, {
        onStatus: (status) => surface.setStatus(status),
        onText: (delta) => surface.appendAssistant(delta),
        onEvent: (event) => surface.handleRunEvent(event),
        signal: controller.signal,
      });
    }
    deps.assertModelBoundToRoute(context.config.mainModel, route);
    const pendingImages = ports.readAttachments();
    if (route.backendId === "openrouter") {
      const runnableModels = await deps.ensureRunnableModelConfiguration(
        context.openRouter,
        context.config,
      );
      if (runnableModels.main) {
        ports.writeModelInfo(runnableModels.main);
      }
      if (pendingImages.length && !ports.readModelInfo()) {
        const snapshot = await deps.loadModelSnapshot(
          context.openRouter,
          context.config.mainModel,
        );
        ports.writeModelInfo(snapshot.model);
      }
      const modelInfo = ports.readModelInfo();
      if (
        pendingImages.length
        && modelInfo
        && !modelInfo.inputModalities.includes("image")
      ) {
        throw new Error(
          `The active model ${context.config.mainModel} does not support images per OpenRouter. Choose a model with "Images" capability using /model; the attachments are kept.`,
        );
      }
    } else if (pendingImages.length > 0) {
      throw new Error("Images are not yet available with a Kimi Code subscription in Orcode.");
    }
    state.submittedImages = pendingImages.map((attachment) => ({ ...attachment }));
    ports.writeAttachments([]);
    surface.setImageAttachments([]);
    const imageSummary = attachmentPromptSummary(state.submittedImages);
    surface.addMessage(
      "user",
      imageSummary ? `${text}\n\n🖼 ${imageSummary}` : text,
    );
    state.runStarted = true;
    surface.beginAssistant(context.config.mainModel);
    const boundAgent = await context.ensureAgentForPrompt(setupSurface);
    context.agent = boundAgent;
    return boundAgent.run(
      text,
      {
        onStatus: (status) => surface.setStatus(status),
        onText: (delta) => surface.appendAssistant(delta),
        onEvent: (event) => {
          surface.handleRunEvent(event);
          // A7: the context-fill header segment is fed from outside —
          // model-end is the only event carrying a fresh inputTokens
          // measurement, ModelInfo.contextLength comes from the model
          // picker's last snapshot.
          const contextLength = ports.readModelInfo()?.contextLength;
          if (event.type === "model-end" && contextLength) {
            const percent = contextFillPercent(event.inputTokens, contextLength);
            if (percent !== undefined) surface.setContextPercent(percent);
          }
        },
        signal: controller.signal,
        interjections,
        endThinking,
      },
      state.submittedImages,
    );
  }, setupSurface);
  state.submittedImages = [];
  surface.setCancelHandler();
  surface.setInterjectHandler();
  surface.setEndThinkingHandler();
  ports.setResolvedModel(result.resolvedModel);
  surface.finishAssistant(result.text);
  surface.setSuggestedReplies(result.suggestions);
  for (const notice of result.notices) {
    surface.addMessage("system", notice, "Notice");
  }
  surface.addMessage("system", deps.runFooter(result, context.config));
  return { kind: "completed", result };
}

export interface RunTurnFailureInput {
  readonly surface: RunSessionSurface;
  readonly context: Pick<RunSessionContext, "config" | "openRouter">;
  readonly deps: Pick<RunSessionDeps, "partialFooter" | "describeRunFailure">;
  readonly ports: Pick<RunSessionPorts, "readAttachments" | "writeAttachments">;
  readonly state: RunTurnState;
  /** The submitted text — a command line as readily as a prompt. */
  readonly text: string;
  readonly error: unknown;
}

/**
 * The one failure path for an interactive submission — a run's and a
 * command's alike, which is why it is a function and not the tail of
 * {@link runSessionTurn}. The dashboard's `catch` wraps command dispatch
 * too, and a failing command must keep behaving exactly as it did.
 *
 * Honesty rules preserved verbatim: a cancelled run says that tool actions
 * already taken were NOT undone; a partial result's cost is still reported
 * when anything was spent or the spend is unknown; the streamed fragment is
 * kept because it is already persisted and hiding it would only hide what
 * the model actually said.
 */
export function applyRunTurnFailure(input: RunTurnFailureInput): void {
  const { surface, context, deps, ports, state, text, error } = input;
  const partial = error instanceof AgentRunError ? error.result : null;
  const cancelled =
    error instanceof AgentRunError
      ? error.outcome === "cancelled"
      : Boolean(state.controller?.signal.aborted) || isAbortError(error);
  surface.setCancelHandler();
  surface.setInterjectHandler();
  surface.setEndThinkingHandler();
  // The fragment is already persisted; discarding it in the UI would only
  // hide what the model actually said before it stopped.
  surface.finishAssistant(partial?.text);
  if (state.submittedImages.length) {
    const restored = [...state.submittedImages, ...ports.readAttachments()];
    ports.writeAttachments(restored);
    validateImageAttachmentSet(restored);
    surface.setImageAttachments(restored);
  }
  for (const notice of partial?.notices ?? []) {
    surface.addMessage("system", notice, "Notice");
  }
  surface.addMessage(
    cancelled ? "system" : "error",
    cancelled
      ? "Run cancelled. Tool actions already taken were not automatically undone; the partial text was saved."
      : deps.describeRunFailure(context.openRouter, error),
  );
  if (partial && (partial.costUsd > 0 || partial.costKnowledge === "unknown")) {
    surface.addMessage("system", deps.partialFooter(partial, context.config));
  }
  // FIX-19 finding 4: nothing ever ran, so nothing consumed the text — it
  // goes back into the composer, editable, instead of being wiped with only
  // an unsaid `↑` to recover it. A run that DID start keeps the old
  // behaviour: its text is in the transcript already.
  if (!state.runStarted) surface.restoreSubmittedDraft(text);
  surface.setStatus("Ready", false);
}
