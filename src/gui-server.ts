#!/usr/bin/env node
/**
 * The GUI sidecar: orcode's core, headless, speaking the G1 protocol over
 * stdio JSON Lines.
 *
 * It is the THIRD interactive surface, not a second implementation. Every
 * truth it serves comes from the same producer the TUI reads: the run stream
 * is `AgentRunEvent` 1:1, commands go through `handleSlashCommand`, the
 * palette is `command-catalog.ts`, Settings is `SettingsController`'s frozen
 * view model, setup is a fifth `SetupSurface` adapter, and a run is
 * `runSessionTurn` — the same controller `runDashboard` calls.
 *
 * Two rules shape the whole file:
 *
 *  R1 (G0's top risk): the core writes the model's answer to `process.stdout`
 *  when `onText` is missing (agent.ts:1291-1293), and `emitStatus` falls back
 *  to a coloured `console.log`. On a stdio protocol that is prose injected
 *  into the JSON stream. So the run controller supplies `onText` and
 *  `onStatus` unconditionally, AND `installStdoutGuard` moves the real
 *  stdout aside at startup so nothing but protocol lines can ever reach it.
 *
 *  R-SEC (G0 §3.5): secrets and secret-derived identities travel INWARD only.
 *  Every outbound frame passes `guardOutboundFrame`; every payload that
 *  starts life as a config-, route- or chat-shaped object is reduced by a
 *  named projection first. A model choice crosses as a server-issued handle,
 *  never as a `RouteIdentityV1`.
 */

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { createOfficialCliHostProbe } from './official-cli-host.js';
import { probeOfficialCli } from './official-cli-probe.js';
import { cliPresentation } from './official-cli-state.js';
import { CodexNativeShellActions } from './native-shell-action.js';
import {LocalProjectRun} from './local-project-run.js';
import {executeLocalFlow,updateLocalPolicy,assertLocalRunGrant,type LocalExecutionPolicy,type LocalRunGrant} from './local-execution-policy.js';
import {runVerify} from './verify.js';
import type { RouteIdentityV1 } from "./backends.js";
import {
  desktopCrossRouteDetails,
  desktopCrossRoutePresentation,
  type DesktopCrossPreflightView,
} from "./cross-gate.js";

import {
  BufferedCommandOutput,
  cliTheme,
  commandAllowedDuringCrossRun,
  commandArguments,
  CROSS_RUN_ACTIVE_COMMAND_NOTICE,
  CROSS_RUN_ACTIVE_MESSAGE_NOTICE,
  commandRequiresRunnableRoute,
  commandTransitionsRunnableRoute,
  createArchitectRuntimeForContext,
  createCrossRuntimeForContext,
  createDashboardArmedTaskEchoAdapter,
  createDashboardCrossGateSurface,
  createSettingsSession,
  crossActivationNotice,
  crossArmedStatusLine,
  crossResultNoticeText,
  crossSnapshotText,
  crossStatusReport,
  defaultCliBootstrapDeps,
  defaultRunSessionDeps,
  publishCrossResultToSession,
  readSettingsCrossRoleRoute,
  resolveCliCommandName,
  runCli,
  stopAndDrainCrossRun,
  withOneShotClearing,
  type CliBootstrapDeps,
  type DashboardRunInput,
  type SettingsOwnerSurface,
} from "./cli.js";
import { sanitizeTerminalText, type ChoicePickerItem } from "./tui.js";
import { DESKTOP_SETTINGS_SIDE_EFFECT_COPY } from "./settings-side-effects.js";
import {
  DESKTOP_ACTIVITY_COPY,
  DESKTOP_COMMAND_DISABLED_COPY,
  projectGermanSettingsEditor,
} from "./desktop-german-copy.js";
import type { DesktopCommandDisabledReasonCode } from "./desktop-contracts.js";
import {
  sameCanonicalModelRoute,
  type ModelRouteCatalogPort,
  type ModelRoutePickerPort,
  type SelectableModelRoute,
} from "./model-route-catalog.js";
import type {
  DesktopRoutePickerCandidate,
  RoutePickerAuthority,
  RoutePickerRequest,
} from "./route-picker.js";
import {
  commandMenuCrumbParts,
  resolveCommandMenuRows,
  type CommandMenuRow,
  type CommandMenuRuntime,
} from "./ui/command-menu.js";
import { handleSlashCommand } from "./commands.js";
import { resolveSlashCommand } from "./command-catalog.js";
import { contextCharsForForecast } from "./compressor.js";
import {
  classifyCostForecastPrice,
  computePromptCostForecast,
  estimateOutputTokenBand,
  formatPromptCostForecast,
} from "./cost-forecast.js";
import { listChatsAcrossWorkspaces, SessionStore, workspaceSpend } from "./session.js";
import {
  openChatSelection,
  readChatSwitchContext,
  VISIBLE_TURNS,
  type ChatSelection,
  type ChatSessionSurface,
} from "./chat-session.js";
import { ProcessEventRedactor } from "./redaction.js";
import { NativeSidecarChannel } from "./native-sidecar-channel.js";
import { KimiDesktopPermitReader } from "./kimi-desktop-permit.js";
import { createDesktopKimiRuntimeCapability } from "./kimi-execution-origin.js";

export function desktopCommandDisabled(code: string) {
  return Object.prototype.hasOwnProperty.call(DESKTOP_COMMAND_DISABLED_COPY, code)
    ? DESKTOP_COMMAND_DISABLED_COPY[code as DesktopCommandDisabledReasonCode]
    : DESKTOP_COMMAND_DISABLED_COPY["provider-unavailable"];
}

/** Exact catalog/parser-owned Desktop front door for the canonical setup flow. */
export function resolveDesktopOnboardingCommand(raw: string): boolean {
  if (!raw.trimStart().startsWith("/")) return false;
  const resolved = resolveSlashCommand(raw);
  return resolved?.handlerId === "provider"
    && resolved.matchedPath.length === 1
    && resolved.matchedPath[0] === "provider"
    && resolved.args.length === 1
    && resolved.args[0] === "setup";
}

function projectDesktopPaletteRow(row: CommandMenuRow, runtime: CommandMenuRuntime): GuiPaletteRow {
  const legacy = projectPaletteRow(row);
  const handlerId = row.kind === "match" ? row.entry.handlerId : row.kind === "node" ? row.node.handlerId : undefined;
  const live = handlerId ? runtime.get(handlerId as import("./command-catalog.js").SlashCommandHandlerId) : undefined;
  const description = row.kind === "recovery"
    ? "Keine Treffer. Alle Befehle zeigen"
    : row.kind === "node"
      ? row.node.desktopDescription ?? (row.node.kind === "branch" ? `Befehlsgruppe ${row.node.name}` : `Befehl /${row.node.name}`)
      : row.entry.desktopDescription ?? `Befehl /${row.entry.name}`;
  return {
    ...legacy,
    ...(row.kind === "recovery" ? { name: "Alle Befehle zeigen" } : {}),
    presentation: {
      ...legacy.presentation,
      description,
      ...(live?.currentLabel ? { currentLabel: live.currentLabel } : {}),
      ...(live?.disabled ? { disabled: live.disabled } : {}),
    },
  };
}
import {
  applyRunTurnFailure,
  createRunTurnState,
  runSessionTurn,
  type RunSessionPorts,
  type RunSessionSurface,
} from "./run-session.js";
import {
  GUI_ASK_KINDS,
  GUI_PROTOCOL_VERSION,
  parseDesktopSettingsIntent,
  parseNativeLocalActionRequirement,
  parseOnboardingIntent,
  parseOfficialCliRequest,
  GuiOutputBatcher,
  guardOutboundFrame,
  projectChatRow,
  projectPaletteRow,
  type GuiPaletteRow,
  type GuiAskKind,
  type GuiChatOpened,
  type GuiChatReset,
  type GuiCostForecast,
  type GuiCrossRoute,
  type GuiConfirmAsk,
  type GuiErrorBody,
  type GuiEventName,
  type GuiRequest,
  type GuiStatus,
} from "./gui-protocol.js";
import {
  createDesktopOnboardingOperationHandle,
  DesktopOnboardingController,
  type DesktopOnboardingActivationResult,
  type DesktopOnboardingAuthority,
} from "./desktop-onboarding.js";
import {
  DesktopSettingsController,
  type DesktopSettingsNavigation,
} from "./desktop-settings.js";
import type {
  DesktopActivity,
  DesktopCapabilitySnapshot,
  DesktopOnboardingIntent,
  DesktopOnboardingResult,
  DesktopOnboardingView,
  DesktopRouteCandidate,
  NativeLocalActionRequirement,
  DesktopSettingsCategoryId,
  DesktopSettingsEditorDecision,
  DesktopSettingsIntent,
  DesktopSettingsView,
} from "./desktop-contracts.js";
import { readPackageVersion } from "./branding.js";
import type { CrossRunResult } from "./collaboration.js";
import type { Theme } from "./ui/theme.js";
import type { AgentRunEvent, BalanceInfo, ModelInfo } from "./types.js";
import type { ImageAttachment } from "./attachments.js";
import type { ChatTurn } from "./types.js";
import { setupModelRowLabel, type SetupSurface } from "./setup-surface/index.js";
import type { SettingsCategoryId } from "./settings-registry.js";
import type {
  SettingsController,
  SettingsEditorRequest,
  SettingsEditorResult,
  SettingsIntent,
} from "./settings-controller.js";
import type { SettingsSessionControl } from "./settings-session.js";

/** What this build can actually serve. The client must not assume more. */
/**
 * How long teardown waits for a cancelled run to settle before saying so.
 *
 * Long enough for an aborted provider call and its tool children to unwind,
 * short enough to stay inside the grace window a shell gives a sidecar
 * before it reaches for SIGKILL (G0 §1.4).
 */
export const SHUTDOWN_DRAIN_MS = 5_000;

/** Mirrors the TUI's `TERMINAL_PROCESS_CAPACITY` (tui.ts). */
export const PROCESS_HEADER_CAPACITY = 512;

export const GUI_CAPABILITIES: readonly string[] = Object.freeze([
  "chat",
  "commands",
  "catalog",
  "chats",
  "status",
  "settings",
  "setup",
  "approvals",
]);

/* =========================================================================
 * R1 — the stdout guard
 * ====================================================================== */

export interface StdoutGuard {
  /** The only writer that may reach the real stdout. */
  writeProtocol(line: string): void;
  /** How many stray writes were intercepted — reported, never hidden. */
  readonly strayWrites: number;
  restore(): void;
}

/**
 * Moves the real stdout aside so only the protocol writer can reach it.
 *
 * G0's R1: with `onText` absent the core streams the whole answer to
 * `process.stdout` (agent.ts:1291-1293), `emitStatus` falls back to
 * `console.log` with ANSI (agent.ts:2161-2171), and `createPlainCommandOutput`
 * writes there too (commands.ts:824-837). The run controller supplies the
 * observer callbacks, which is the real fix; this is the belt that makes a
 * missed one visible instead of corrupting the stream. Stray bytes are
 * routed to `diagnostic` (stderr, which is explicitly NOT protocol) and
 * counted.
 */
export function installStdoutGuard(
  diagnostic: (chunk: string) => void,
  stream: NodeJS.WriteStream = process.stdout,
): StdoutGuard {
  const original = stream.write.bind(stream) as (chunk: string) => boolean;
  let stray = 0;
  let inProtocolWrite = false;
  const guarded = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (inProtocolWrite) return original(String(chunk));
    stray += 1;
    diagnostic(typeof chunk === "string" ? chunk : String(chunk));
    // Honour the callback contract so a caller awaiting drain never hangs.
    const callback = rest.find((entry) => typeof entry === "function");
    if (typeof callback === "function") (callback as () => void)();
    return true;
  }) as unknown as NodeJS.WriteStream["write"];
  stream.write = guarded;
  return {
    writeProtocol(line: string): void {
      inProtocolWrite = true;
      try {
        original(line);
      } finally {
        inProtocolWrite = false;
      }
    },
    get strayWrites(): number {
      return stray;
    },
    restore(): void {
      stream.write = original as unknown as NodeJS.WriteStream["write"];
    },
  };
}

/* =========================================================================
 * Errors — one description path, and typed refusals
 * ====================================================================== */

/**
 * A refusal this server states itself: our own copy, our own code, naming
 * the state that blocked the request.
 *
 * Distinct from a failure that came out of the core, because the two need
 * opposite treatment at the boundary: our copy is safe to send verbatim, and
 * anything the core threw must go through `safeMessage` first (M2).
 */
export class GuiRequestRefused extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "GuiRequestRefused";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

/** Internal control flow: an accepted request lost its response authority. */
class GuiResponseRetired extends Error {
  constructor() {
    super("The request response was retired.");
    this.name = "GuiResponseRetired";
  }
}

/**
 * The ONE way an error becomes outbound text.
 *
 * The TUI feeds every failing submission — commands included — through
 * `openRouter.safeMessage` (`formatFailure(explain(error))`), which exists to
 * keep provider bodies, URLs and request ids off a surface; the repo's
 * privacy contract (commands.ts:5305-5307) bans exactly those. The GUI's run
 * path already used it via `applyRunTurnFailure`; this makes every other path
 * use the same helper, so no second description of a failure exists.
 *
 * `describe` is installed by the session once `context.openRouter` exists.
 * Before that — a bootstrap failure, a malformed frame — the fallback says
 * only that something failed, because a message from an unexplained error is
 * exactly the raw text this finding is about.
 */
export function describeRequestFailure(
  error: unknown,
  describe: (error: unknown) => string,
): GuiErrorBody {
  if (error instanceof GuiRequestRefused) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {}),
    };
  }
  const local=localFailure(error);
  if(local)return local;
  return { code: "request-failed", message: describe(error) };
}

/** Closed local codes only; never forward an arbitrary exception message. */
function localFailure(error:unknown):GuiErrorBody|null {
  if(!(error instanceof Error))return null;
  const messages:Record<string,string>={
    'original-baseline-changed':'Das Original wurde inzwischen geändert. Nichts wurde übernommen. Prüfe die Unterschiede, bevor du die Arbeitskopie aktualisierst.',
    'candidate-changed':'Die Arbeitskopie wurde seit der Prüfung geändert. Bitte erneut prüfen.',
    'tested-candidate-changed':'Die Arbeitskopie wurde während der Prüfung geändert. Bitte erneut prüfen.',
    'candidate-changed-during-scan':'Die Arbeitskopie wurde während der Erfassung geändert. Bitte erneut prüfen.',
    'apply-needs-tested-confirmed-candidate':'Die Übernahme benötigt einen unveränderten, bestandenen Test und deine Bestätigung.',
    'candidate-mode-change-unsupported':'Geänderte Ausführungsrechte werden noch nicht übernommen. Bitte diese Rechteänderung separat prüfen.',
    'local-isolation-unavailable':'Die lokale Ausführungsisolation ist auf diesem System noch nicht verfügbar. Es wurde kein Auftrag gestartet.',
    'local-isolation-canary-failed':'Die lokale Schutzprüfung ist fehlgeschlagen. Es wurde kein Auftrag gestartet.',
    'local-start-retired':'Die Arbeitskopie ist gestoppt. Wähle ausdrücklich „Fortsetzen“, bevor du weiterarbeitest.',
    'local-run-stopped':'Die Arbeitskopie ist gestoppt. Wähle ausdrücklich „Fortsetzen“, bevor du weiterarbeitest.',
    'local-process-retired':'Die Aktion wurde durch Stop oder eine neue Auswahl verworfen.',
  };
  return Object.hasOwn(messages,error.message)?{code:error.message,message:messages[error.message]!}:null;
}

/* =========================================================================
 * D4 — the confirm grammar, as one mapping
 * ====================================================================== */

/**
 * The three confirm states, exactly as `confirmPlain` grades them
 * (approval.ts:53-61), turned into a wire payload.
 *
 *  - danger            → consequence on its own line, `defaultAccept:false`,
 *                        an explicit Confirm control that is never default.
 *  - ordinary          → `defaultAccept:true`, Enter accepts.
 *  - ordinary, no dflt → ordinary presentation with danger's key grammar —
 *                        FIX-14's third state, threaded WHOLE rather than
 *                        collapsed onto `danger` (which would give `/panel`'s
 *                        spend confirm a destructive title it must not have).
 *
 * Exported so the mapping is pinnable on its own; the session has no second
 * copy of it.
 */
export function guiConfirmAskPayload(
  request: { readonly title: string; readonly consequence?: string },
  options: { readonly danger?: boolean; readonly defaultAccept?: boolean } = {},
): GuiConfirmAsk {
  const danger = options.danger === true;
  return {
    title: request.title,
    ...(request.consequence ? { consequence: request.consequence } : {}),
    danger,
    defaultAccept: danger ? false : options.defaultAccept ?? true,
  };
}

/* =========================================================================
 * Transport
 * ====================================================================== */

export interface GuiTransportIo {
  readonly input: NodeJS.ReadableStream;
  writeLine(line: string): void;
  diagnostic(text: string): void;
}

type RequestHandler = (request: GuiRequest) => Promise<unknown>;

/**
 * One JSON object per line, both ways.
 *
 * Reading never blocks on work: an `answer` resolves whatever ask is
 * pending, everything else is dispatched to the handler as it arrives. That
 * is what makes `cancel` reachable WHILE a run holds the loop — the exact
 * property a request/response queue would destroy.
 */
export class GuiTransport {
  readonly #io: GuiTransportIo;
  readonly #pendingAsks = new Map<string, {
    readonly owner?: object;
    readonly resolve: (answer: Record<string, unknown>) => void;
  }>();
  #handler: RequestHandler | null = null;
  /**
   * Until the session installs `context.openRouter.safeMessage`, an
   * unexplained error is described by a sentence that carries nothing from
   * it — never `error.message`, which is where provider bodies live.
   */
  #describeError: (error: unknown) => string = () =>
    "The engine could not complete that request.";
  /**
   * The technical tail the wire deliberately does not carry, kept for the
   * developer on stderr — which is explicitly not protocol (G0 §3.1), and
   * which the shell must still redact before showing in a debug pane
   * (R-SEC-5). Installed together with the describer.
   */
  #diagnoseError: (error: unknown) => string = () => "";
  #handshake = false;
  #closed = false;
  #unparseable = 0;
  #onClose: (() => void) | null = null;
  #reader: ReturnType<typeof createInterface> | null = null;
  #afterResponse: (() => void) | null = null;
  #terminalAfterResponse = false;
  #onHandshake: (() => void) | null = null;

  constructor(io: GuiTransportIo) {
    this.#io = io;
  }

  get handshakeComplete(): boolean {
    return this.#handshake;
  }

  get unparseableLines(): number {
    return this.#unparseable;
  }

  /** How many questions are waiting for a human. Used by the submit guard. */
  get pendingAskCount(): number {
    return this.#pendingAsks.size;
  }

  /** Settles modal setup input without accepting it or closing the pipe. */
  abandonPendingAsks(owner?: object): void {
    for (const [askId, pending] of [...this.#pendingAsks]) {
      if (owner !== undefined && pending.owner !== owner) continue;
      this.#pendingAsks.delete(askId);
      pending.resolve({ abandoned: true });
    }
  }

  /**
   * Runs once the CURRENT request's response has been written.
   *
   * Teardown closes the transport, and a closed transport writes nothing —
   * so a handler that ends the session (`shutdown`, `/quit`) must not start
   * teardown before its own acknowledgement is on the wire. Ordering, not a
   * delay: a microtask or a timer only makes the race less likely.
   */
  afterResponse(run: () => void): void {
    this.#afterResponse = run;
    this.#terminalAfterResponse = true;
  }

  /** Installed by the session so every outbound failure text has one source. */
  setErrorDescriber(
    describe: (error: unknown) => string,
    diagnose: (error: unknown) => string = describe,
  ): void {
    this.#describeError = describe;
    this.#diagnoseError = diagnose;
  }

  start(handler: RequestHandler, onClose: () => void, onHandshake?: () => void): void {
    this.#handler = handler;
    this.#onClose = onClose;
    this.#onHandshake = onHandshake ?? null;
    const reader = createInterface({ input: this.#io.input, crlfDelay: Infinity });
    this.#reader = reader;
    reader.on("line", (line) => {
      void this.#accept(line);
    });
    // Parent death: stdin EOF is the only reliable macOS signal that the
    // shell that spawned us is gone (there is no PR_SET_PDEATHSIG). G0's D1
    // chose stdio partly for this.
    reader.on("close", () => this.close());
  }

  async #accept(line: string): Promise<void> {
    const raw = line.trim();
    if (!raw) return;
    let parsed: GuiRequest;
    try {
      parsed = JSON.parse(raw) as GuiRequest;
    } catch {
      // Never rendered as content: a non-JSON line is counted and named,
      // because treating it as prose is exactly how R1's stdout leak would
      // reappear as chat text on the other side.
      this.#unparseable += 1;
      this.emit("notice", {
        kind: "warn",
        message: `The client sent ${this.#unparseable} line(s) that were not protocol JSON.`,
      });
      return;
    }
    if (!parsed || typeof parsed.t !== "string") {
      this.#unparseable += 1;
      return;
    }
    if (parsed.t === "answer") {
      const askId = typeof parsed.askId === "string" ? parsed.askId : "";
      const pending = this.#pendingAsks.get(askId);
      if (!pending) {
        this.emit("notice", {
          kind: "warn",
          message: "An answer arrived for a question that is no longer open.",
        });
        return;
      }
      this.#pendingAsks.delete(askId);
      pending.resolve(parsed as unknown as Record<string, unknown>);
      return;
    }
    const id = typeof parsed.id === "string" ? parsed.id : null;
    if (parsed.t === "hello-ack") {
      const protocol = typeof parsed.protocol === "number" ? parsed.protocol : null;
      if (protocol !== GUI_PROTOCOL_VERSION) {
        if (id) {
          this.respondError(id, {
            code: "protocol-mismatch",
            message: `This engine speaks protocol ${GUI_PROTOCOL_VERSION}; the client speaks ${protocol ?? "an unstated version"}.`,
            hint: "Update the app and the engine together.",
          });
        }
        this.emit("fatal", {
          code: "protocol-mismatch",
          message: `This engine speaks protocol ${GUI_PROTOCOL_VERSION}; the client speaks ${protocol ?? "an unstated version"}.`,
        });
        return;
      }
      const firstHandshake = !this.#handshake;
      this.#handshake = true;
      if (id) this.respondOk(id, { protocol: GUI_PROTOCOL_VERSION });
      if (firstHandshake) this.#onHandshake?.();
      return;
    }
    if (!this.#handshake) {
      if (id) {
        this.respondError(id, {
          code: "handshake-required",
          message: "Send hello-ack before anything else.",
        });
      }
      return;
    }
    // A terminal request has already claimed the next response boundary.
    // Lines queued behind it must not enter handlers or create effects.
    if (this.#terminalAfterResponse) return;
    const handler = this.#handler;
    if (!handler) return;
    try {
      const result = await handler(parsed);
      if (id) this.respondOk(id, result);
      const after = this.#afterResponse;
      this.#afterResponse = null;
      after?.();
    } catch (error) {
      if (error instanceof GuiResponseRetired) return;
      // M2: never `error.message`. One description path, the same one the
      // TUI trusts for exactly this reason.
      const body = describeRequestFailure(error, this.#describeError);
      if (!(error instanceof GuiRequestRefused)) {
        this.#io.diagnostic(
          `orcode-gui: request "${parsed.t}" failed: ${this.#diagnoseError(error)}\n`,
        );
      }
      if (id) this.respondError(id, body);
      else this.emit("notice", { kind: "error", message: body.message });
    }
  }

  /** Every outbound frame goes through here — and through the guard. */
  #send(frame: Record<string, unknown>): void {
    if (this.#closed) return;
    const { value, findings } = guardOutboundFrame({ v: GUI_PROTOCOL_VERSION, ...frame });
    this.#io.writeLine(`${JSON.stringify(value)}\n`);
    if (findings.length) {
      // Said out loud, and never with the offending value: the finding
      // names a path and a reason, exactly like `SecretFinding` does.
      const paths = findings.map((finding) => `${finding.path} (${finding.reason})`).join(", ");
      this.#io.diagnostic(
        `orcode-gui: the outbound boundary redacted ${findings.length} field(s): ${paths}\n`,
      );
    }
  }

  hello(payload: Record<string, unknown>): void {
    this.#send({ t: "hello", ...payload });
  }

  respondOk(id: string, result: unknown): void {
    this.#send({ t: "response", id, ok: true, result: result ?? null });
  }

  respondError(id: string, error: { code: string; message: string; hint?: string }): void {
    this.#send({ t: "response", id, ok: false, error });
  }

  emit(event: GuiEventName, payload: Record<string, unknown> = {}): void {
    this.#send({ t: "event", e: event, ...payload });
  }

  /**
   * Asks a question and waits for the answer.
   *
   * The promise RESOLVES on abandonment and never rejects — `awaitSetupInput`
   * (setup-surface/index.ts:197-211) races these against an abort signal, and
   * a rejection would tear down a hub that is designed to be cancellable. A
   * closed transport resolves the fallback, so a window that goes away mid
   * question never leaves a run hanging on a promise nobody can settle.
   */
  ask<T>(
    kind: GuiAskKind,
    payload: Record<string, unknown>,
    abandoned: T,
    read: (answer: Record<string, unknown>) => T,
    owner?: object,
  ): Promise<T> {
    if (this.#closed) return Promise.resolve(abandoned);
    const askId = randomUUID();
    return new Promise<T>((resolve) => {
      this.#pendingAsks.set(askId, {
        ...(owner === undefined ? {} : { owner }),
        resolve: (answer) => {
          try {
            resolve(read(answer));
          } catch {
            resolve(abandoned);
          }
        },
      });
      this.#send({ t: "ask", askId, kind, ...payload });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Let the session synchronously mark/abort owned work before modal
    // fallbacks settle it. EOF must be an abort boundary, not merely an
    // unanswered-question fallback.
    this.#onClose?.();
    // Never auto-accept: an abandoned `approval` that resolved `true` would
    // silently authorize a file write. Every pending ask gets its own
    // caller's declared fallback instead, which is always the refusal.
    this.abandonPendingAsks();
    // m6: `shutdown` and `/quit` tore the session down but the PROCESS stayed
    // alive — the readline interface keeps `process.stdin` referenced, so the
    // event loop never drains and the sidecar only exited when the CLIENT
    // closed the pipe. All three exit triggers must end the process on their
    // own; a shell that asked politely should not have to reach for a kill.
    this.#reader?.close();
    this.#reader = null;
    const input = this.#io.input as NodeJS.ReadableStream & {
      pause?: () => void;
      unref?: () => void;
    };
    input.pause?.();
    input.unref?.();
  }
}

/** Emits display state only; native prompting and its result stay on private pipes. */
export function emitSecretlessNativeLocalActionRequirement(
  transport: GuiTransport,
  requirement: NativeLocalActionRequirement,
): void {
  const closed = parseNativeLocalActionRequirement(requirement);
  const projection: NativeLocalActionRequirement = {
    kind: closed.kind,
    revision: closed.revision,
    generation: closed.generation,
    purposeCode: closed.purposeCode,
  };
  transport.emit("native-local-action-required", {
    requirement: projection,
  });
}

/* =========================================================================
 * The session
 * ====================================================================== */

function desktopRoutePickerItem(candidate: DesktopRoutePickerCandidate): ChoicePickerItem {
  return {
    value: candidate.handle,
    label: desktopCrossRoutePresentation(candidate),
    description: `${desktopCrossRouteDetails(candidate)} · ${candidate.cost.label} · ${candidate.dataPolicy.label}`,
    ...(candidate.disabled ? { disabled: candidate.disabled.label } : {}),
  };
}

/**
 * Re-project one exact core-private route through the CURRENT Desktop
 * authority. The returned object is rebuilt field by field: neither the
 * route identity nor provider/connection routing keys can cross the wire.
 * Authority drift is represented as `null`; display-name guessing is never
 * a fallback.
 */
function projectDesktopCrossRoute(
  authority: RoutePickerAuthority,
  role: "lead" | "challenger",
  route: RouteIdentityV1 | null,
): GuiCrossRoute | null {
  if (!route || route.canonicalModelId === null) return null;
  try {
    const request: RoutePickerRequest = { role };
    const view = authority.view(request);
    const matches: DesktopRoutePickerCandidate[] = [];
    for (const candidate of view.candidates) {
      if (candidate.canonicalModelId !== route.canonicalModelId
        || !candidate.runnable || candidate.disabled) continue;
      const resolved = authority.resolve(request, {
        handle: candidate.handle,
        revision: view.revision,
        generation: view.generation,
      });
      if (sameCanonicalModelRoute(resolved.route, route)) matches.push(resolved.candidate);
    }
    if (matches.length !== 1) return null;
    const candidate = matches[0]!;
    return Object.freeze({
      providerLabel: candidate.providerLabel,
      accountLabel: candidate.accountLabel,
      displayName: candidate.displayName,
      canonicalModelId: candidate.canonicalModelId,
      reasoning: candidate.reasoning,
      capabilities: Object.freeze([...candidate.capabilities]),
    });
  } catch {
    return null;
  }
}

interface GuiSessionState {
  balance: BalanceInfo | null;
  resolvedModel: string;
  currentModelInfo: ModelInfo | null;
  pendingImages: ImageAttachment[];
  runActive: boolean;
  /**
   * M1: the floating promise a `submit` starts. Teardown awaits it after
   * cancelling, so the process never outlives the shell with a run still
   * spending — the scenario D1 chose stdio to avoid.
   */
  runSettled: Promise<void> | null;
  /** M3: one command at a time; two share `guiOut` and the context. */
  commandInFlight: boolean;
  /**
   * The ONE-SHOT slot the palette fills when it replaces the composer with a
   * draft-taking command, mirroring `TerminalUi.#crossCommandDraft`
   * (tui.ts:522): captured at the one capture site, consumed exactly once,
   * `""` otherwise. Nothing else ever writes it — a plain message is not a
   * pending task.
   */
  commandDraft: string | null;
  /**
   * What `consumeCrossCommandDraft` sets aside so an abandoned gate can put
   * the captured text back (tui.ts:766-771). Cleared by a started run, which
   * consumes the draft permanently (`discardCrossCommandDraft`).
   */
  commandDraftRestore: string | null;
  /** The session cost when this chat was adopted, for the balance figure. */
  startingSessionCost: number;
}

/**
 * The GUI's counterpart to `runDashboard`: it wires the same ports to the
 * protocol instead of to a terminal, then serves requests until the client
 * says `shutdown` or its end of the pipe closes.
 */
export async function runGuiSession(
  context: DashboardRunInput,
  transport: GuiTransport,
  io: Pick<GuiTransportIo, "diagnostic"> = { diagnostic: () => {} },
): Promise<void> {
  let manufacturerOperation = new AbortController();
  let localRun:LocalProjectRun|null=null;
  let localCandidateHandle=randomUUID();
  let localCandidateHash='';
  let localPolicy:LocalExecutionPolicy={aiProcess:'manual',permissions:'ask',revision:1};
  let localGrant:LocalRunGrant|null=null;
  let localProcessAbort=new AbortController();
  let restoredSessionId='';
  let localRecovery:Promise<void>|null=null;
  let guiStopEpoch=0;
  const publishLocal = () => {
    const view=localRun?.view();
    if(view && view.candidateHash!==localCandidateHash){localCandidateHash=view.candidateHash;localCandidateHandle=randomUUID();}
    const result={policy:{...localPolicy},active:state.runActive||state.commandInFlight,candidate:view?{id:view.id,candidateHandle:localCandidateHandle,
      phase:view.phase,originalWorkspace:view.originalRoot,changes:view.changes,
      tested:view.testedHash===view.candidateHash}:null};
    if(transport.handshakeComplete)transport.emit('local-run.state',result);
    return result;
  };
  const manufacturerActions = context.desktopCodexNativeLogin
    ? new CodexNativeShellActions({...context.desktopCodexNativeLogin,
      appServer:{async request<T>():Promise<T> {throw new Error('manufacturer-account-method-forbidden');}}})
    : null;
  const state: GuiSessionState = {
    balance: null,
    resolvedModel: "",
    currentModelInfo: null,
    pendingImages: [],
    runActive: false,
    runSettled: null,
    commandInFlight: false,
    commandDraft: null,
    commandDraftRestore: null,
    startingSessionCost: context.session.data.costs.totalUsd,
  };
  const guiOut = new BufferedCommandOutput();
  context.out = guiOut;
  // M2: one description path for every request/notice failure.
  //
  // `safePanelMessage` (openrouter.ts:1116) is not a second description — it
  // is the repo's OWN second RENDERER over the same `explain()`
  // classification, added for `/panel` because that surface has no room for
  // the technical tail. It renders `message` + `action` and deliberately
  // drops `OpenRouterFailure.detail`, the one clause that carries raw
  // provider text (a request id, a response body) — and it returns a fixed
  // sentence for `unknown`, where `safeMessage` would otherwise return
  // `error.message` verbatim. That is precisely the hole this finding names.
  //
  // Fix round 2, controller ruling: ON THE WIRE the boundary rule outranks
  // TUI parity — run-failure frames route through the same detail-dropping
  // renderer as everything else (the second describer below), while the TUI
  // keeps `safeMessage` for its OWN rendering. Stderr receives the same safe
  // classification, not raw provider/request detail.
  const describeError = (error: unknown): string =>
    localFailure(error)?.message??context.openRouter.safePanelMessage(error);
  transport.setErrorDescriber(
    describeError,
    describeError,
  );
  const boundedShutdownSettlements = new WeakMap<Promise<unknown>, Promise<boolean>>();
  const settleWithinShutdownBound = (
    settling: Promise<unknown>,
    what: string,
  ): Promise<boolean> => {
    const existing = boundedShutdownSettlements.get(settling);
    if (existing) return existing;
    const bounded = (async (): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const drained = await Promise.race([
        settling.then(() => true, () => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), SHUTDOWN_DRAIN_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!drained) {
        io.diagnostic(
          `orcode-gui: ${what} did not stop within ${SHUTDOWN_DRAIN_MS}ms of shutdown.\n`,
        );
      }
      return drained;
    })();
    boundedShutdownSettlements.set(settling, bounded);
    return bounded;
  };
  /**
   * The run's own deps, with exactly one member replaced.
   *
   * Controller ruling (fix round 2): a run failure crosses as an ordinary
   * `transcript` frame, so the wire's rule applies to it like any other
   * outbound text — `safeMessage`'s `· Details:` clause carries request ids
   * and provider bodies. Everything else about a run stays the dashboard's,
   * from the same frozen object, so the two surfaces cannot drift on
   * anything but this deliberate difference.
   */
  const guiRunDeps = Object.freeze({
    ...defaultRunSessionDeps,
    describeRunFailure: (_openRouter: unknown, error: unknown) => {
      // Diagnostics retain the safe classification without restoring unsafe
      // provider or request detail.
      io.diagnostic(`orcode-gui: run failed: ${describeError(error)}\n`);
      return describeError(error);
    },
  });

  /* --- the run surface ------------------------------------------------ */

  let cancelHandler: (() => void) | undefined;
  let interjectHandler: ((text: string) => void) | undefined;
  let endThinkingHandler: (() => void) | undefined;

  // R-SEC-2: the third redaction pass. The run stream is already redacted in
  // the core (agent.ts:553) and in the run log (runlog.ts:111); this one is
  // the credential-safety barrier that buffers process output ACROSS chunk
  // boundaries and catches a secret split over two writes. The TUI keeps it
  // (tui.ts:1252) and so must every other surface.
  const redactor = new ProcessEventRedactor();
  // G0 §3.4 L1: the core cannot be back-pressured, so the sidecar coalesces.
  // Line-hold means a reader never sees a torn line; the ceiling drops the
  // MIDDLE and says how much, because a silent drop would be a lie.
  const outputBatcher = new GuiOutputBatcher({ holdPartialLine: true });
  const textBatcher = new GuiOutputBatcher();
  // m4: one retained header per `id:stream`, bounded exactly as the TUI
  // bounds its own terminal-id memory (TERMINAL_PROCESS_CAPACITY, tui.ts) —
  // a long session with many tool calls must not grow a map forever. Oldest
  // out first; a header only matters while its stream is still arriving.
  const processHeaders = new Map<string, AgentRunEvent & { type: "process-output" }>();
  const rememberProcessHeader = (
    key: string,
    event: AgentRunEvent & { type: "process-output" },
  ): void => {
    processHeaders.delete(key);
    processHeaders.set(key, event);
    while (processHeaders.size > PROCESS_HEADER_CAPACITY) {
      const oldest = processHeaders.keys().next();
      if (oldest.done) break;
      processHeaders.delete(oldest.value);
    }
  };
  let flushTimer: NodeJS.Timeout | null = null;

  const flushAssistant = (): void => {
    for (const chunk of textBatcher.drain({ flushPartial: true })) {
      transport.emit("assistant", { phase: "delta", delta: chunk.text });
    }
  };
  const flushOutput = (all: boolean): void => {
    for (const chunk of outputBatcher.drain({ flushPartial: all })) {
      const header = processHeaders.get(chunk.key);
      if (!header) {
        // Practically unreachable (a stream would have to go quiet for 512
        // other streams), but a silent drop is a lie by this file's own rule.
        transport.emit("notice", {
          kind: "warn",
          message: `${chunk.text.length} characters of tool output were dropped: its stream was evicted from the buffer.`,
        });
        continue;
      }
      transport.emit("run", { event: { ...header, text: chunk.text } });
      if (chunk.elided > 0) {
        transport.emit("notice", {
          kind: "warn",
          message: `${chunk.elided} characters of tool output were elided to keep the stream bounded.`,
        });
      }
    }
  };
  const scheduleFlush = (): void => {
    if (flushTimer) return;
    // The TUI's own 30 ms render debounce, reused as the emit tick.
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushAssistant();
      flushOutput(false);
    }, 30);
    flushTimer.unref?.();
  };
  const flushAll = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushAssistant();
    flushOutput(true);
  };

  const emitRunEvent = (event: AgentRunEvent): void => {
    if (event.type === "process-output") {
      const key = `${event.id}:${event.stream}`;
      rememberProcessHeader(key, event);
      outputBatcher.push(key, event.text);
      scheduleFlush();
      return;
    }
    // Ordering: anything else must not overtake output already buffered.
    flushAll();
    transport.emit("run", { event });
  };

  const surface: RunSessionSurface = {
    setCancelHandler(handler) {
      cancelHandler = handler;
    },
    setInterjectHandler(handler) {
      interjectHandler = handler;
    },
    setEndThinkingHandler(handler) {
      endThinkingHandler = handler;
    },
    setImageAttachments(attachments) {
      transport.emit("attachments", {
        files: attachments.map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })),
      });
    },
    addMessage(role, content, meta) {
      // The same sanitize the dashboard applies (tui.ts:314): `commands.ts`
      // hands `out.text` pre-coloured ANSI from ~125 sites, and C0/C1 plus
      // bidi overrides are a spoofing vector in an HTML surface.
      const clean = sanitizeTerminalText(content).trim();
      if (!clean) return;
      transport.emit("transcript", { role, content: clean, ...(meta ? { meta } : {}) });
    },
    beginAssistant(model) {
      flushAll();
      transport.emit("assistant", { phase: "begin", model });
    },
    appendAssistant(delta) {
      textBatcher.push("assistant", delta);
      scheduleFlush();
    },
    finishAssistant(fallback) {
      flushAll();
      transport.emit("assistant", {
        phase: "end",
        ...(fallback === undefined ? {} : { text: sanitizeTerminalText(fallback) }),
      });
    },
    setStatus(status, busy = true) {
      transport.emit("status", { text: sanitizeTerminalText(status), busy });
    },
    setSuggestedReplies(replies) {
      transport.emit("suggestions", { replies: [...replies] });
    },
    setContextPercent(percent) {
      transport.emit("context-percent", { percent: percent ?? null });
    },
    handleRunEvent(event) {
      for (const redacted of redactor.push(event)) emitRunEvent(redacted);
      if (event.type === "run-end") {
        for (const trailing of redactor.flushAll()) emitRunEvent(trailing);
        flushAll();
      }
    },
    // Round-2 re-review: the draft EVENT is the whole mechanism — the client
    // owns the composer, so the server keeps no copy (the old `lastDraft`
    // register was write-only dead state, and its live cousin was M2's bug).
    restoreSubmittedDraft(text) {
      transport.emit("draft", { text, reason: "restore" });
    },
    insertInputText(text) {
      transport.emit("draft", { text, reason: "insert" });
    },
  };

  const runPorts: RunSessionPorts = {
    readAttachments: () => state.pendingImages,
    writeAttachments: (next) => { state.pendingImages = next; },
    readModelInfo: () => state.currentModelInfo,
    writeModelInfo: (next) => { state.currentModelInfo = next; },
    setResolvedModel: (model) => { state.resolvedModel = model; },
  };

  /* --- the ask-backed ports ------------------------------------------- */

  const askConfirm = (
    title: string,
    consequence: string,
    options: { danger?: boolean; defaultAccept?: boolean } = {},
    owner?: object,
  ): Promise<boolean> =>
    transport.ask(
      "confirm",
      { ...guiConfirmAskPayload({ title, consequence }, options) },
      // A confirm that nobody answers is a confirm that was NOT given.
      false,
      (answer) => answer.accepted === true,
      owner,
    );

  const askChoice = <T extends { value: string }>(
    title: string,
    items: readonly T[],
    current: string,
    initial?: string,
    owner?: object,
  ): Promise<T | null> =>
    transport.ask<T | null>(
      "choice",
      {
        title,
        items: items.map((item) => ({ ...item })),
        current,
        initial: initial ?? current,
      },
      null,
      (answer) => (typeof answer.value === "string"
        ? items.find((item) => item.value === answer.value) ?? null
        : null),
      owner,
    );

  const askSecret = (label: string, owner?: object): Promise<string | null> =>
    // R-SEC-4: one-directional. The value travels client → server in an
    // `answer` and is never echoed in any event, response or log line.
    transport.ask(
      "secret",
      { label },
      null,
      (answer) => (typeof answer.value === "string" ? answer.value : null),
      owner,
    );

  /* --- the chat-open surface ------------------------------------------- */

  // G1b: `openChatSelection` (chat-session.ts) is the SAME machinery the
  // dashboard's Recent row runs — session handoff, route adoption, the
  // workspace re-root and its notice, the stale-entry offer, and the
  // `isUntouched` ghost-file guard. This surface is the only thing that
  // differs between the two.
  let pendingTurns: readonly ChatTurn[] = [];
  const chatSurface: ChatSessionSurface = {
    addMessage: (role, content, meta) => surface.addMessage(role, content, meta),
    setStatus: (status, busy) => surface.setStatus(status, busy),
    loadTurns: (turns) => { pendingTurns = turns; },
    confirmAction: (title, details, options) =>
      // `TerminalUi.confirmAction` defaults `danger` to TRUE — the inversion
      // trap G0 flagged, and the opposite of `confirmPlain`'s default. The
      // GUI must default the same way or the stale-entry deletion would
      // become an Enter-accepts question.
      askConfirm(title, details, { danger: options?.danger !== false })
        .then((accepted) => ({ accepted })),
  };

  /* --- the execution-mode trust rule (G2 concern 1) -------------------- */

  /**
   * The ruling, implemented: the shell's env statement CORROBORATES, it does
   * not decide. `context.executionMode` is what `deriveProviderExecutionMode`
   * derived from this process's own stdio — `piped`, for a sidecar — and
   * nothing here upgrades it, because a claim a launcher makes about itself
   * is not a fact this process can check.
   *
   * Owner-only terminal paths stay unavailable. Their technical mode fact is
   * diagnostic-only; the public Desktop snapshot carries the user-facing,
   * German availability state for each provider.
   */
  const executionModeFacts = Object.freeze({
    derived: context.executionMode,
    ...(process.env.ORCODE_GUI_EXECUTION_MODE
      ? { launcherClaim: process.env.ORCODE_GUI_EXECUTION_MODE }
      : {}),
    ownerPathsAllowed: context.executionMode === "local-interactive-owner",
  });
  if (!executionModeFacts.ownerPathsAllowed) {
    if (executionModeFacts.launcherClaim) {
      // The launcher said something about itself and it changed nothing. Said
      // once, on stderr, so a developer reading the log is not left guessing
      // why the variable appears to be ignored — it is ignored on purpose.
      io.diagnostic(
        `orcode-gui: execution mode is "${executionModeFacts.derived}" (derived); `
        + `the launcher claimed "${executionModeFacts.launcherClaim}", which is corroborating, not load-bearing.\n`,
      );
    }
  }

  /* --- setup surface (the fifth adapter) ------------------------------- */

  /**
   * FIX-18's pre-prompt disclosure, held for the prompt it belongs to.
   *
   * A NON-outcome notice is a disclosure written to be read immediately
   * before the next prompt (the login-type and cost-boundary sentence, the
   * Kimi replace consequence). Both terminal adapters fold it into that
   * prompt rather than letting it float: plain through `promptMessage`, the
   * TUI through its `pendingSecretNotice` transcript push. This window folds
   * it into the `secret` ask's own payload, which is the same rule on a
   * surface where the prompt is a panel.
   */
  let pendingSetupDisclosure: string | null = null;

  const setupSurface: SetupSurface = {
    chooseHub(entries) {
      const selectable = entries.filter((entry) => !entry.disabled);
      if (!selectable.length) return Promise.resolve(null);
      const current = selectable.find((entry) => entry.current)?.id ?? "";
      return transport.ask(
        "choose-hub",
        {
          // FIX-11: one name for one screen. The plain and TUI adapters both
          // title it "Provider setup"; a third wording would be the drift the
          // iron rules forbid.
          title: "Provider setup",
          current,
          entries: selectable.map((entry) => ({
            id: entry.id,
            label: entry.label,
            description: entry.description,
            current: entry.current === true,
          })),
          // Disabled rows are shown but never pickable — the contract every
          // adapter honours (setup-surface/index.ts:31-37).
          unavailable: entries
            .filter((entry) => entry.disabled)
            .map((entry) => ({ id: entry.id, label: entry.label, reason: entry.description })),
        },
        null,
        (answer) => {
          const id = typeof answer.id === "string" ? answer.id : null;
          return id && selectable.some((entry) => entry.id === id) ? id : null;
        },
      );
    },
    readSecret(request) {
      const notice = pendingSetupDisclosure;
      pendingSetupDisclosure = null;
      return transport.ask(
        "secret",
        {
          label: request.message,
          ...(notice ? { notice } : {}),
          // FIX-18 (Esc depth): the key stage steps BACK to the provider list
          // on Escape; the TUI says so in its own hint and so does this panel.
          escHint: "Esc goes back to the provider list",
        },
        null,
        // R-SEC-4: one-directional. The value travels client → server in an
        // `answer` and is never echoed in any event, response or log line.
        (answer) => (typeof answer.value === "string" ? answer.value : null),
      );
    },
    chooseModel(request) {
      // Dedup by canonical id, exactly as the TUI adapter does
      // (setup-surface/index.ts:1617) — the plain adapter does not, and the
      // TUI's behaviour is the honest one for a list a person reads.
      const seen = new Set<string>();
      const models = request.models.filter((model) => {
        if (seen.has(model.canonicalModelId)) return false;
        seen.add(model.canonicalModelId);
        return true;
      });
      return transport.ask(
        "choose-model",
        {
          title: "Choose a model",
          backendId: request.backendId,
          models: models.map((model) => ({
            // G4 finding 1: the contract is the CANONICAL id — `runSetupHub`
            // matches the answer with `model.canonicalModelId === selected`
            // (setup-surface/index.ts:744-746), and both terminal adapters
            // hand back exactly that. This adapter answered with
            // `requestedModelId`, so every route whose two ids differ (the
            // shipped `openrouter/auto` among them) fell through to "The
            // selected model route is unavailable." and retried forever.
            id: model.canonicalModelId,
            // The same row copy the terminal shows. `setupModelRowLabel` is
            // where the automatic route's honest description lives; printing
            // `displayName` here made the window call it "Auto".
            name: setupModelRowLabel(model),
            requestedModelId: model.requestedModelId,
            capabilities: { ...model.capabilities },
          })),
        },
        null,
        (answer) => {
          const id = typeof answer.id === "string" ? answer.id : null;
          return id && models.some((model) => model.canonicalModelId === id) ? id : null;
        },
      );
    },
    confirm(request) {
      // The plain adapter forces `default = false` for danger and prints the
      // consequence; the TUI adapter drops the consequence entirely
      // (setup-surface/index.ts:1622-1625). The GUI has room for it, so it
      // ships — the honest superset of both.
      return askConfirm(request.message, request.consequence ?? "", {
        danger: request.danger === true,
        defaultAccept: request.danger === true ? false : request.defaultValue,
      });
    },
    present(event) {
      if (event.type === "notice") {
        if (event.outcome === true) {
          // FIX-18: a SETTLED outcome renders durably on every surface. On
          // this one that means the transcript, which survives the next
          // prompt exactly as the terminal's does.
          pendingSetupDisclosure = null;
        } else if (event.busy !== true) {
          pendingSetupDisclosure = event.message;
        }
        // The TUI puts every notice on its status line too (`ui.setStatus`),
        // `busy` and all; the same line exists here.
        surface.setStatus(event.message, event.busy ?? false);
      }
      transport.emit("setup.present", { presentation: event });
    },
  };
  context.providerRouteSurface = setupSurface;

  /* --- settings surface ------------------------------------------------ */

  // One Desktop-policy authority owns both public views and core resolution
  // for the lifetime of this GUI server. It can never inherit owner policy.
  const settingsRouteAuthority = context.providerRuntime.routePickerAuthority?.() ?? null;

  type GuiSettingsPhase = "opening" | "open" | "closing" | "closed";
  interface GuiSettingsRestoreState {
    readonly selectedCategoryId: DesktopSettingsCategoryId;
    readonly query: string;
    readonly expandedCategoryIds: readonly DesktopSettingsCategoryId[];
    readonly focusNavigation?: DesktopSettingsNavigation;
  }
  interface GuiSettingsOperation {
    readonly askOwner: object;
    readonly coreCategory: SettingsCategoryId;
    readonly desktopCategory: DesktopSettingsCategoryId;
    readonly restoreState: GuiSettingsRestoreState | null;
    phase: GuiSettingsPhase;
    desktop: DesktopSettingsController | null;
    control: SettingsSessionControl | null;
    tail: Promise<void>;
    completion: Promise<void>;
    closeSettlement: Promise<void> | null;
    openedPublished: boolean;
    closedPublished: boolean;
    responseRetired: boolean;
  }

  /** Claimed synchronously by either Settings entry point. */
  let activeSettings: GuiSettingsOperation | null = null;

  const emitSettingsActivity = (
    code: "settings-opened" | "settings-closed",
    revision: number,
  ): void => {
    transport.emit("activity", {
      activity: {
        id: randomUUID(),
        revision,
        kind: "settings",
        level: "info",
        message: DESKTOP_ACTIVITY_COPY[code],
      } satisfies DesktopActivity,
    });
  };

  const emitDesktopSettingsView = (
    operation: GuiSettingsOperation,
    view: DesktopSettingsView,
  ): void => {
    if (operation.phase === "closed") return;
    transport.emit("settings.view", { view });
  };

  const emitGuiSettingsNotice = (
    operation: GuiSettingsOperation,
    message: string,
    kind: "info" | "error" = "info",
  ): void => {
    if (operation.phase === "closed") return;
    const clean = sanitizeTerminalText(message).trim();
    if (!clean) return;
    transport.emit("notice", { kind, message: clean });
  };

  const finalizeSettingsOperation = (operation: GuiSettingsOperation): void => {
    if (operation.closedPublished) return;
    operation.closedPublished = true;
    operation.phase = "closed";
    if (activeSettings === operation) activeSettings = null;
    if (operation.openedPublished && operation.desktop) {
      emitSettingsActivity("settings-closed", operation.desktop.view.revision);
    }
    transport.emit("settings.closed");
  };

  const settingsSurfaceFor = (operation: GuiSettingsOperation): SettingsOwnerSurface => ({
    // The terminal lease is a no-op here: this surface owns no terminal, so
    // `runSettingsTerminalOwner` degrades to a plain call (E-LEASE).
    start() {},
    stop() {},
    applyAppearance() {
      // The GUI's appearance is CSS on the other side of the pipe; the saved
      // config is what the client re-reads. Nothing to apply in-process.
    },
    async begin(_view, control, controller: SettingsController) {
      operation.control = control;
      const desktop = new DesktopSettingsController(controller, {
        edit: (request) => editSettings(request, operation),
      });
      operation.desktop = desktop;
      if (operation.phase === "closed") {
        control.requestClose();
        return;
      }
      let view = desktop.view;
      const selectedCategoryId = operation.restoreState?.selectedCategoryId
        ?? operation.desktopCategory;
      if (selectedCategoryId !== "model") {
        view = await desktop.dispatch({
          kind: "select-category",
          categoryId: selectedCategoryId,
          revision: view.revision,
        });
      }
      for (const categoryId of operation.restoreState?.expandedCategoryIds ?? []) {
        view = await desktop.dispatch({
          kind: "toggle-advanced",
          categoryId,
          revision: view.revision,
        });
      }
      if (operation.restoreState?.query) {
        view = await desktop.dispatch({
          kind: "search-change",
          query: operation.restoreState.query,
          revision: view.revision,
        });
      }
      const initialFocusKey = operation.restoreState?.focusNavigation
        ? desktop.focusKeyForNavigation(operation.restoreState.focusNavigation)
        : null;
      if (initialFocusKey) view = Object.freeze({ ...view, initialFocusKey });
      const closing = operation.phase === "closing";
      if (!closing) operation.phase = "open";
      emitDesktopSettingsView(operation, view);
      operation.openedPublished = true;
      emitSettingsActivity("settings-opened", view.revision);
      if (closing) control.requestClose();
    },
    nextIntent() {
      // Desktop intents are dispatched through the operation lane below. The
      // core session pump waits only for its explicit close control.
      return new Promise<SettingsIntent>(() => {});
    },
    edit(request) {
      return editSettings(request, operation);
    },
    end() {
      finalizeSettingsOperation(operation);
    },
    setBusy(active) {
      if (operation.phase === "closed") return;
      transport.emit("status", {
        text: active ? "Änderung wird angewendet …" : "Bereit",
        busy: active,
      });
    },
    pickChoice(title, items, currentValue, initialValue) {
      if (operation.phase !== "open") return Promise.resolve(null);
      return askChoice(title, items, currentValue, initialValue, operation.askOwner);
    },
    readSecret(label) {
      if (operation.phase !== "open") return Promise.resolve(null);
      return askSecret(label, operation.askOwner);
    },
    pickModel(search, currentModel, title) {
      if (operation.phase !== "open") return Promise.resolve(null);
      const models = search("");
      if (operation.phase !== "open") return Promise.resolve(null);
      return askChoice(
        title ?? "Choose a model",
        models.map((model) => ({
          value: model.id,
          label: model.name,
          description: model.description ?? "",
        })),
        currentModel,
        currentModel,
        operation.askOwner,
      ).then((selected) => (selected ? { id: selected.value } : null));
    },
    confirmAction(title, details, options) {
      if (operation.phase !== "open") {
        return Promise.resolve({ accepted: false });
      }
      return askConfirm(title, details, {
        danger: options?.danger !== false,
      }, operation.askOwner).then((accepted) => ({ accepted }));
    },
    showSettingsNotice(message) {
      emitGuiSettingsNotice(operation, message);
    },
    showSettingsSideEffect(code) {
      const copy = DESKTOP_SETTINGS_SIDE_EFFECT_COPY[code];
      emitGuiSettingsNotice(operation, copy.message, copy.kind);
    },
    restoreSettings() {},
    addMessage(role, content) {
      emitGuiSettingsNotice(operation, content, role === "error" ? "error" : "info");
    },
  });

  /**
   * The pending editor, held by object identity.
   *
   * The controller's staleness check is `pending.request !== request`
   * (settings-controller.ts:588-590) — an identity comparison no JSON
   * boundary survives. So the request object stays here and the client's
   * reply is matched on `generation` + `itemId`.
   */
  const editSettings = async (
    request: SettingsEditorRequest,
    operation: GuiSettingsOperation,
  ): Promise<SettingsEditorResult> => {
    if (operation.phase !== "open") return { kind: "cancel" };
    const descriptor = request.editor;
    if (
      descriptor.kind === "model"
      && descriptor.multiple !== true
      && (
        descriptor.actionId === "main-model"
        || descriptor.actionId === "compressor-model"
        || descriptor.actionId === "cross-lead-model"
        || descriptor.actionId === "cross-challenger-model"
        || descriptor.actionId === "architect-executor-model"
      )
    ) {
      const role = descriptor.actionId === "main-model"
        ? "main"
        : descriptor.actionId === "compressor-model"
          ? "compressor"
          : descriptor.actionId === "cross-lead-model"
            ? "lead"
            : descriptor.actionId === "cross-challenger-model"
              ? "challenger"
              : "executor";
      const authority = settingsRouteAuthority;
      if (!authority) return { kind: "cancel" };
      const pickerRequest = { role } as const;
      const view = authority.view(pickerRequest);
      if (operation.phase !== "open") return { kind: "cancel" };
      const choice = await askChoice(
        request.label,
        view.candidates.map(desktopRoutePickerItem),
        "",
        "",
        operation.askOwner,
      );
      const candidate = choice && view.candidates.find((row) => row.handle === choice.value);
      return candidate?.runnable && !candidate.disabled
        ? { kind: "value", value: { kind: "model-route", selection: {
            handle: candidate.handle, revision: view.revision, generation: view.generation,
          } } }
        : { kind: "cancel" };
    }
    if (descriptor.kind === "model" || descriptor.kind === "readonly") {
      return { kind: "cancel" };
    }
    const projected = projectGermanSettingsEditor(request, randomUUID());
    return transport.ask<SettingsEditorResult>(
      "settings-editor",
      { editor: projected.editor },
      { kind: "cancel" },
      (answer) => projected.resolve(readEditorDecision(answer)),
      operation.askOwner,
    );
  };

  /* --- Desktop-authority model command adapter ------------------------- */

  const desktopRows = (request: RoutePickerRequest, rawQuery: string): readonly SelectableModelRoute[] => {
    if (!settingsRouteAuthority) return [];
    const query = rawQuery.trim();
    if (!query) return [];
    const view = settingsRouteAuthority.view(request);
    const candidates = view.candidates.filter((candidate) => {
      if (!candidate.runnable || candidate.disabled
        || !candidate.capabilities.includes("text")
        || !candidate.capabilities.includes("tools")) return false;
      return candidate.canonicalModelId === query;
    });
    try {
      const resolved = candidates.map((candidate) => ({
        candidate,
        selection: settingsRouteAuthority.resolve(request, {
          handle: candidate.handle,
          revision: view.revision,
          generation: view.generation,
        }),
      }));
      if (resolved.some(({ candidate, selection }) =>
        selection.selection.handle !== candidate.handle
        || selection.selection.revision !== view.revision
        || selection.selection.generation !== view.generation
        || selection.connectionId !== candidate.connectionId
        || selection.candidate.canonicalModelId !== query
        || !selection.candidate.runnable || Boolean(selection.candidate.disabled)
        || !selection.candidate.capabilities.includes("text")
        || !selection.candidate.capabilities.includes("tools"))) return [];
      const rebound = settingsRouteAuthority.view(request);
      const reboundHandles = rebound.candidates.filter((candidate) =>
        candidate.runnable && !candidate.disabled
        && candidate.capabilities.includes("text")
        && candidate.capabilities.includes("tools")
        && candidate.canonicalModelId === query).map((candidate) => candidate.handle).sort();
      const initialHandles = candidates.map((candidate) => candidate.handle).sort();
      if (rebound.revision !== view.revision || rebound.generation !== view.generation
        || JSON.stringify(reboundHandles) !== JSON.stringify(initialHandles)) return [];
      return resolved.map(({ candidate, selection }) => Object.freeze({
          route: selection.route,
          providerLabel: candidate.accountLabel,
          model: Object.freeze({
            id: selection.route.requestedModelId,
            name: candidate.displayName,
            contextLength: 0,
            reasoning: candidate.reasoning === "supported"
              ? { mandatory: false, supportedEfforts: null, supportsMaxTokens: false }
              : undefined,
            price: Object.freeze({ kind: "unknown" as const }),
          }),
          supportsTools: true,
          supportsReasoning: candidate.reasoning === "supported",
          selected: false,
        }));
    } catch {
      return [];
    }
  };
  const desktopCatalog: ModelRouteCatalogPort = Object.freeze({
    async listSelectableModelRoutes(query: string) { return desktopRows({ role: "main" }, query); },
  });
  const modelRoutePicker: ModelRoutePickerPort = Object.freeze({
    async pickModelRoute(input: Parameters<ModelRoutePickerPort["pickModelRoute"]>[0]) {
      const request: RoutePickerRequest = { role: input.role };
      const view = settingsRouteAuthority?.view(request);
      if (!view) return null;
      const candidates = view.candidates;
      const selected = await askChoice(input.title, candidates.map(desktopRoutePickerItem), "", "");
      if (!selected) return null;
      const candidate = candidates.find((row) => row.handle === selected.value);
      if (!candidate || !candidate.runnable || candidate.disabled
        || !candidate.capabilities.includes("text")
        || !candidate.capabilities.includes("tools")) return null;
      const resolved = settingsRouteAuthority!.resolve(request, {
        handle: candidate.handle, revision: view.revision, generation: view.generation,
      });
      if (input.exclude && sameCanonicalModelRoute(resolved.route, input.exclude)) return null;
      return Object.freeze({
        route: resolved.route,
        providerLabel: candidate.accountLabel,
        model: Object.freeze({
          id: resolved.route.requestedModelId,
          name: candidate.displayName,
          contextLength: 0,
          reasoning: candidate.reasoning === "supported"
            ? { mandatory: false, supportedEfforts: null, supportsMaxTokens: false }
            : undefined,
          price: Object.freeze({ kind: "unknown" as const }),
        }),
        supportsTools: true,
        supportsReasoning: candidate.reasoning === "supported",
        selected: false,
      });
    },
  });
  context.modelRoutePicker = modelRoutePicker;
  context.providerRoutes = new Proxy(context.providerRuntime, {
    get(target, property) {
      if (property === "listSelectableModelRoutes") {
        return desktopCatalog.listSelectableModelRoutes.bind(desktopCatalog);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  /* --- command context wiring ------------------------------------------ */

  context.confirm = async (request, options) =>
    askConfirm(request.title, request.consequence ?? "", {
      danger: options?.danger === true,
      ...(options?.defaultAccept !== undefined ? { defaultAccept: options.defaultAccept } : {}),
    });
  context.promptFolderPath = (request) =>
    transport.ask(
      "folder-path",
      { label: request.label, description: request.description },
      null,
      (answer) => (typeof answer.path === "string" ? answer.path : null),
    );
  // F2's consumer seam: the raw key is a PARAMETER and never a return value,
  // so it exists only inside `use` and never enters a protocol frame.
  context.withCredentialSecret = async (kind, use) => {
    const secret = await askSecret(
      kind === "inference" ? "OpenRouter API key" : "OpenRouter management key",
    );
    if (secret === null) return "cancelled";
    await use(secret);
    return "used";
  };
  context.readCachedBalance = () => state.balance;
  context.seedNextMessage = (text) => surface.insertInputText(text);
  context.onPanelResult = (result) => {
    surface.addMessage("system", `Panel answered with ${result.answers.length} model(s).`, "/panel");
  };
  context.onRunEvent = (event) => surface.handleRunEvent(event);
  /**
   * The one-shot bridge into a bare draft-taking command's preflight —
   * `TerminalUi.consumeCrossCommandDraft`/`restoreCrossCommandDraft`, on this
   * surface. One slot, one capture site (a `command` request's `draft`), one
   * read; `""` when nothing was captured, which is what makes a bare
   * `/cross` on an empty composer behave exactly as it does in the terminal:
   * the gate offers the continuation task, or arms a pending one-shot.
   */
  context.composerDraft = {
    read: () => {
      const draft = state.commandDraft ?? "";
      state.commandDraft = null;
      if (draft) state.commandDraftRestore = draft;
      return draft;
    },
    restore: () => {
      const draft = state.commandDraftRestore;
      state.commandDraftRestore = null;
      if (draft) transport.emit("draft", { text: draft, reason: "restore" });
    },
  };
  /* --- Cross (G1 concern 1) -------------------------------------------- */

  // The dashboard's own runtime, its own gate surface, its own launch/echo
  // discipline — wired to this surface instead of to a terminal. Nothing
  // about Cross is re-decided here: `createDashboardCrossGateSurface` needs
  // exactly `setStatus` and `pickChoice`, both of which this session already
  // has, so the gate the window shows IS the gate the dashboard shows, with
  // the same rows, the same blocked reasons, the same think levels and the
  // same `descriptionParts` — FIX-14's floor marker and its figure travelling
  // as ONE part so no surface can cut between them.
  let activeCrossRun: Promise<CrossRunResult | null> | null = null;
  const launchCrossRun = (run: Promise<CrossRunResult>): void => {
    const observed = run
      .catch((error: unknown) => {
        // Same boundary rule as every other outbound failure on this wire.
        surface.addMessage("error", describeError(error), "Cross");
        io.diagnostic(`orcode-gui: cross run failed: ${describeError(error)}\n`);
        return null;
      })
      .finally(() => {
        if (activeCrossRun === observed) activeCrossRun = null;
      });
    activeCrossRun = observed;
  };
  context.crossRunActive = () => activeCrossRun !== null;
  // Resolved per call, never captured: `cliTheme` reads
  // `config.appearance.glyphMode`, which Settings can change mid-session —
  // a captured theme would keep printing yesterday's glyphs.
  const crossTheme = (): Theme => cliTheme(context.config);
  const armedTaskEcho = createDashboardArmedTaskEchoAdapter((task) => {
    surface.addMessage("user", task);
  });
  /**
   * The live Cross panel, on the wire.
   *
   * G3 shipped the gate, the price and the published result but not the panel
   * the dashboard renders WHILE the coordinator runs — a paid two-model run
   * showed one status line and nothing else. The frame is
   * `dashboardState()`'s own bounded projection. Once a run has produced a
   * sequence, its settled state remains as the honest action surface: route
   * mutation is blocked while active and becomes reachable only after the
   * coordinator settles. `state: null` means no run has happened yet.
   */
  let crossPreflight: DesktopCrossPreflightView | null = null;
  const publishCrossPanel = (): void => {
    const state = crossRuntime?.dashboardState();
    const preferences = state && state.sequence > 0
      ? crossRuntime?.dashboardPreferences() ?? null
      : null;
    const liveState = state && state.sequence > 0
      ? {
          ...state,
          lead: settingsRouteAuthority && preferences
            ? projectDesktopCrossRoute(settingsRouteAuthority, "lead", preferences.run.lead)
            : null,
          challenger: settingsRouteAuthority && preferences
            ? projectDesktopCrossRoute(settingsRouteAuthority, "challenger", preferences.run.challenger)
            : null,
          ...(!state.active && preferences
            ? {
                selection: {
                  lead: settingsRouteAuthority
                    ? projectDesktopCrossRoute(settingsRouteAuthority, "lead", preferences.current.lead)
                    : null,
                  challenger: settingsRouteAuthority
                    ? projectDesktopCrossRoute(settingsRouteAuthority, "challenger", preferences.current.challenger)
                    : null,
                },
              }
            : {}),
        }
      : null;
    transport.emit("cross", {
      state: liveState,
      preflight: crossPreflight,
    });
  };
  const publishCrossPreflight = (next: DesktopCrossPreflightView | null): void => {
    crossPreflight = next;
    publishCrossPanel();
  };
  const crossRuntime = createCrossRuntimeForContext(
    context as never,
    modelRoutePicker,
    {
      restoreDraft: (draft) => {
        // The captured composer draft wins; the gate's own pending task is
        // the FALLBACK, and it may only land in an empty composer — the same
        // order and the same guard `restoreCrossCommandDraft` applies
        // (FIX-20 finding 6). The emptiness is the client's to check,
        // because the composer is the client's.
        const captured = state.commandDraftRestore;
        state.commandDraftRestore = null;
        if (captured) {
          transport.emit("draft", { text: captured, reason: "restore" });
          return;
        }
        if (draft) transport.emit("draft", { text: draft, reason: "fallback" });
      },
      // A started Cross run consumes the palette draft permanently.
      discardDraft: () => {
        state.commandDraft = null;
        state.commandDraftRestore = null;
      },
      commitArmedTask: armedTaskEcho.commit,
      clearCommittedArmedTask: armedTaskEcho.clear,
      async publishResult(result, task, pair, leadIdentity) {
        const alreadyEchoed = armedTaskEcho.consume(task);
        const published = await publishCrossResultToSession(
          context.session,
          result,
          task,
          pair,
          crossTheme(),
          leadIdentity,
        );
        if (!published) return;
        if (published.kind === "notice") {
          surface.addMessage(
            "system",
            crossResultNoticeText(crossTheme(), published.pair, published.result),
          );
          return;
        }
        // P15: the ANSWER first. `crossResultBlock` puts the reasoning behind
        // the answer in the persisted turn, and this stream renders a
        // reasoning block collapsed by default for exactly the same reason.
        if (published.user && !alreadyEchoed) surface.addMessage("user", published.user);
        surface.addMessage("assistant", published.assistant);
      },
      publishSnapshot: (snapshot) => {
        surface.setStatus(crossSnapshotText(crossTheme(), snapshot), false);
        publishCrossPanel();
      },
      publishStatus: (snapshot, mode) =>
        // The transcript, never the status line: a one-line transient is
        // exactly why `/cross status`'s run half used to vanish (FIX-20 #3).
        surface.addMessage("system", crossStatusReport(crossTheme(), snapshot, mode), "Cross"),
      notifyActivated: (pair, detail) =>
        surface.addMessage("system", crossActivationNotice(pair, detail), "Cross"),
      launchRun: launchCrossRun,
      beginRun(stop) {
        cancelHandler = stop;
        surface.setStatus("Cross is running");
        publishCrossPanel();
      },
      endRun() {
        cancelHandler = undefined;
        surface.setStatus("Ready", false);
        // FIX-20 findings 1/2: the panel is the LIVE run's rendering and only
        // that. The terminal outcome is published as its own transcript block,
        // so a panel left standing would be a second rendering of one fact,
        // below newer lines, with an older timestamp.
        publishCrossPanel();
      },
      // The coordinator's own per-transition hook — the same one the
      // dashboard re-renders on, so the window's panel changes exactly when
      // the terminal's does.
      refresh() {
        publishCrossPanel();
      },
    },
    createDashboardCrossGateSurface({
      setStatus: (status: string, busy?: boolean) => surface.setStatus(status, busy),
      pickChoice: (
        title: string,
        items: readonly ChoicePickerItem[],
        currentValue: string,
        initialValue?: string,
      ) => askChoice(title, items, currentValue, initialValue),
    } as never, {
      publishPreflight: publishCrossPreflight,
      pickPreflightChoice: (input) => transport.ask(
        "choice",
        {
          title: input.title,
          presentation: "cross-preflight",
          task: input.task,
          items: input.items.map((item) => ({ ...item })),
          current: "",
          initial: input.preflight.startDisabled ? "coding" : "start",
        },
        null,
        (answer) => typeof answer.value === "string"
          ? input.items.find((item) => item.value === answer.value) ?? null
          : null,
      ),
      confirmStart: async (title, consequence) => {
        return await askConfirm(title, consequence, {
          danger: false,
          defaultAccept: false,
        });
      },
    }),
    {
      async pickModelRoute(input) {
        const choice = await askChoice(
          input.title,
          input.view.candidates.map(desktopRoutePickerItem),
          input.currentHandle ?? "",
          input.currentHandle ?? "",
        );
        if (!choice) return null;
        const candidate = input.view.candidates.find((row) => row.handle === choice.value);
        return candidate?.runnable && !candidate.disabled
          ? { handle: candidate.handle, revision: input.view.revision, generation: input.view.generation }
          : null;
      },
    },
    settingsRouteAuthority,
  );
  context.cross = crossRuntime;
  context.architect = createArchitectRuntimeForContext(context as never);
  // A chat loaded already armed says so once, like the plain loop's own
  // startup line — the window has no persistent Cross segment yet.
  if (context.session.data.crossMode) {
    surface.addMessage("system", crossArmedStatusLine(context.session.data.crossMode), "Cross");
  }
  // Deliberately NOT `createSettingsCommandPort`: that port refuses unless
  // stdin AND stdout are TTYs (cli.ts), which a sidecar can never be. The
  // gate it enforces — an interactive owner — is satisfied here by a
  // different fact, so this is a parallel entry point to the SAME session
  // factory, not a second Settings implementation.
  const settingsCategoriesFor = (
    category: SettingsCategoryId | DesktopSettingsCategoryId | undefined,
  ): { readonly core: SettingsCategoryId; readonly desktop: DesktopSettingsCategoryId } => {
    switch (category) {
      case undefined:
      case "models":
      case "model":
        return { core: "models", desktop: "model" };
      case "accounts":
        return { core: "accounts", desktop: "accounts" };
      case "approvals-costs":
      case "security":
        return { core: "approvals-costs", desktop: "security" };
      case "tools":
      case "appearance":
      case "more":
        return { core: category === "appearance" ? "appearance" : "tools", desktop: "more" };
      default:
        throw new GuiRequestRefused("invalid-category", "That Settings area is unavailable.");
    }
  };

  const startSettings = (
    category?: SettingsCategoryId | DesktopSettingsCategoryId,
    restoreState: GuiSettingsRestoreState | null = null,
  ): GuiSettingsOperation => {
    if (activeSettings) {
      throw new GuiRequestRefused("settings-open", "Settings is already open.");
    }
    const categories = settingsCategoriesFor(category);
    const operation: GuiSettingsOperation = {
      askOwner: Object.freeze({}),
      coreCategory: categories.core,
      desktopCategory: categories.desktop,
      restoreState,
      phase: "opening",
      desktop: null,
      control: null,
      tail: Promise.resolve(),
      completion: Promise.resolve(),
      closeSettlement: null,
      openedPublished: false,
      closedPublished: false,
      responseRetired: false,
    };
    activeSettings = operation;
    operation.completion = (async () => {
      const session = createSettingsSession(
        context as never,
        settingsSurfaceFor(operation),
        false,
        settingsRouteAuthority,
      );
      await session.open(operation.coreCategory);
    })().finally(() => finalizeSettingsOperation(operation));
    return operation;
  };

  const enqueueSettings = <T>(
    operation: GuiSettingsOperation,
    task: () => Promise<T>,
  ): Promise<T> => {
    const result = operation.tail.then(task, task);
    operation.tail = result.then(() => undefined, () => undefined);
    return result;
  };

  const dispatchSettings = (
    operation: GuiSettingsOperation,
    intent: DesktopSettingsIntent,
  ): Promise<DesktopSettingsView> => enqueueSettings(operation, async () => {
    if (operation.phase !== "open" || !operation.desktop) {
      throw new GuiRequestRefused("settings-closing", "Settings is closing.");
    }
    const view = await operation.desktop.dispatch(intent);
    emitDesktopSettingsView(operation, view);
    return view;
  });

  const awaitSettingsResponse = async <T>(
    operation: GuiSettingsOperation,
    settling: Promise<T>,
  ): Promise<T> => {
    let result: T;
    try {
      result = await settling;
    } catch (error) {
      if (operation.responseRetired) throw new GuiResponseRetired();
      throw error;
    }
    if (operation.responseRetired) throw new GuiResponseRetired();
    return result;
  };

  const requestSettingsClose = (operation: GuiSettingsOperation): Promise<void> => {
    if (operation.closeSettlement) return operation.closeSettlement;
    if (operation.phase === "closed") return Promise.resolve();
    operation.phase = "closing";
    // The owner is captured by every Settings ask, including the model-route
    // choice. This wakes exactly that editor and cannot abandon an approval,
    // setup prompt or chat-owned question.
    transport.abandonPendingAsks(operation.askOwner);
    const claimedTail = operation.tail;
    operation.closeSettlement = (async () => {
      await claimedTail;
      operation.control?.requestClose();
      await operation.completion.catch(() => undefined);
    })();
    return operation.closeSettlement;
  };

  const beginSettingsShutdown = (): GuiSettingsOperation | null => {
    const operation = activeSettings;
    if (operation) void requestSettingsClose(operation);
    return operation;
  };

  context.settings = Object.freeze({
    // The `/settings` command's own port. It runs INSIDE a command request,
    // so it does not re-run `assertSessionIdle` (its own command already
    // holds the lane) — but it claims the flag synchronously for the same
    // reason the request handler does.
    async open(category?: SettingsCategoryId): Promise<void> {
      const operation = startSettings(category);
      await operation.completion;
    },
  });
  context.approvals.setPromptHandler(async (preview) => {
    const decision = await transport.ask(
      "approval",
      {
        preview,
        rememberAvailable: true,
        reasonAvailable: true,
        // A tool approval is a consent point: never a default-accepted control.
        danger: true,
      },
      { accepted: false },
      (answer) => ({
        accepted: answer.accepted === true,
        ...(answer.remember === "allow" || answer.remember === "deny"
          ? { remember: answer.remember as "allow" | "deny" }
          : {}),
        ...(typeof answer.reason === "string" ? { reason: answer.reason } : {}),
      }),
    );
    return decision;
  });
  context.startDeferredRetention?.((warning) => {
    transport.emit("notice", { kind: "warn", message: warning });
  });
  for (const warning of new Set(context.startupWarnings ?? [])) {
    transport.emit("notice", { kind: "warn", message: warning });
  }

  /* --- authoritative Desktop onboarding ------------------------------- */

  type OnboardingTarget =
    | { readonly kind: "navigation" }
    | { readonly kind: "empty-openrouter" }
    | { readonly kind: "empty-nanogpt" }
    | { readonly kind: "empty-codex" }
    | {
        readonly kind: "model";
        readonly providerId: string;
        readonly connectionId: string;
        readonly canonicalModelId: string;
        readonly selectedHandle: string;
      };
  interface OnboardingOperation {
    readonly operationHandle: string;
    readonly askOwner: object;
    readonly abort: AbortController;
    readonly cancellationReason: Error;
    readonly controller: DesktopOnboardingController;
    readonly baseline: DesktopCapabilitySnapshot;
    readonly target: OnboardingTarget;
    emptySetupCommit: DesktopOnboardingActivationResult | null;
    codexRetentionCompleted: boolean;
    promise: Promise<DesktopOnboardingResult>;
    cancelSettlement: Promise<DesktopOnboardingResult> | null;
    cancelOwnsFinal: boolean;
    finalPublished: boolean;
    suppressFinal: boolean;
  }

  let desktopAuthority: DesktopOnboardingAuthority | null = null;
  let onboarding: DesktopOnboardingController | null = null;
  let onboardingOperation: OnboardingOperation | null = null;
  interface SettingsOnboardingReturn {
    readonly source: GuiSettingsOperation;
    readonly restore: GuiSettingsRestoreState;
    readonly entry: "model" | "provider" | "account";
    readonly providerId?: "openrouter" | "kimi-code" | "nano-gpt";
    readonly suppressOperationOverlay: boolean;
    atEntry: boolean;
  }
  let settingsOnboardingReturn: SettingsOnboardingReturn | null = null;
  let chatMutationInFlight = false;

  const projectSettingsOnboardingView = (
    view: DesktopOnboardingView,
  ): DesktopOnboardingView => {
    const owner = settingsOnboardingReturn;
    if (!owner) return view;
    const projected = { ...view, returnTo: "settings" as const };
    if (!owner.atEntry) return projected;
    if (owner.entry === "account") {
      return {
        revision: projected.revision,
        generation: projected.generation,
        step: "account",
        returnTo: "settings",
        providers: projected.providers,
        providerId: owner.providerId!,
        ...(projected.operationHandle && !owner.suppressOperationOverlay
          ? { operationHandle: projected.operationHandle }
          : {}),
        candidates: [],
      };
    }
    return {
      revision: projected.revision,
      generation: projected.generation,
      step: owner.entry === "provider" ? "provider" : "model",
      returnTo: "settings",
      providers: projected.providers,
      ...(projected.operationHandle && !owner.suppressOperationOverlay
        ? { operationHandle: projected.operationHandle }
        : {}),
      candidates: owner.entry === "model"
        ? projected.providers.flatMap((provider) => provider.routes)
        : [],
    };
  };

  const projectOnboardingView = (
    controller: DesktopOnboardingController,
  ): ReturnType<DesktopOnboardingController["snapshot"]> => {
    const view = controller.snapshot();
    const active = onboardingOperation;
    if (!active || active.finalPublished || active.controller !== controller) {
      return projectSettingsOnboardingView(view);
    }
    if (view.operationHandle !== undefined && view.operationHandle !== active.operationHandle) {
      throw new Error("The active Desktop onboarding operation identity is inconsistent.");
    }
    return projectSettingsOnboardingView({ ...view, operationHandle: active.operationHandle });
  };

  const observeSettingsOnboardingResult = (
    intent: DesktopOnboardingIntent,
    result: DesktopOnboardingResult,
  ): DesktopOnboardingResult => {
    const owner = settingsOnboardingReturn;
    if (!owner) return result;
    if (result.kind === "view" && intent.kind !== "open-model-picker") {
      owner.atEntry = owner.entry === "provider"
        ? result.view.step === "provider"
        : owner.entry === "account"
          ? result.view.step === "account" && result.view.providerId === owner.providerId
        : result.view.step === "model"
          && result.view.providerId === undefined
          && result.view.connectionId === undefined;
    }
    return result.kind === "view" || result.kind === "cancelled"
      ? { ...result, view: projectSettingsOnboardingView(result.view) }
      : result;
  };

  const restoreSettingsAfterOnboarding = (): void => {
    const owner = settingsOnboardingReturn;
    if (!owner) return;
    settingsOnboardingReturn = null;
    const operation = startSettings(owner.source.coreCategory, owner.restore);
    void operation.completion.catch((error: unknown) => {
      transport.emit("notice", {
        kind: "error",
        message: describeRequestFailure(error, describeError).message,
      });
    });
  };

  const beginDesktopShutdown = (): void => {
    const captured = onboardingOperation;
    if (!captured) return;
    captured.suppressFinal = true;
    captured.abort.abort(new Error("The Desktop window closed."));
  };

  const desktopActivity = (
    code: DesktopActivity["message"]["code"],
    label: string,
    snapshot: DesktopCapabilitySnapshot,
  ): void => {
    transport.emit("activity", {
      activity: {
        id: randomUUID(),
        revision: snapshot.revision,
        generation: snapshot.generation,
        kind: "setup",
        level: "info",
        message: { code, label },
      } satisfies DesktopActivity,
    });
  };

  const currentDesktop = (): {
    authority: DesktopOnboardingAuthority;
    controller: DesktopOnboardingController;
    snapshot: DesktopCapabilitySnapshot;
  } => {
    if (!desktopAuthority || !onboarding) {
      throw new GuiRequestRefused(
        "desktop-starting",
        "Provider setup is still starting.",
        "wait for the Desktop snapshot",
      );
    }
    const snapshot = desktopAuthority.snapshot();
    const view = onboarding.snapshot();
    if (
      !onboardingOperation
      && (view.revision !== snapshot.revision || view.generation !== snapshot.generation)
    ) {
      onboarding = new DesktopOnboardingController({ authority: desktopAuthority });
    }
    return { authority: desktopAuthority, controller: onboarding, snapshot };
  };

  const publishDesktop = (): DesktopCapabilitySnapshot | null => {
    if (!transport.handshakeComplete || !desktopAuthority || !onboarding) return null;
    const current = currentDesktop();
    transport.emit("desktop.snapshot", { snapshot: current.snapshot });
    transport.emit("onboarding.view", { view: projectOnboardingView(current.controller) });
    return current.snapshot;
  };

  const candidateForActiveRoute = (
    snapshot: DesktopCapabilitySnapshot,
  ): DesktopRouteCandidate | undefined => snapshot.activeRoute
    ? snapshot.providers.flatMap((provider) => provider.routes)
      .find((candidate) => candidate.handle === snapshot.activeRoute?.routeHandle)
    : undefined;

  const operationCommitted = (
    operation: OnboardingOperation,
    snapshot: DesktopCapabilitySnapshot,
  ): boolean => {
    if (
      !snapshot.routeRunnable
      || !snapshot.activeRoute
      || snapshot.revision <= operation.baseline.revision
      || snapshot.generation <= operation.baseline.generation
    ) return false;
    const active = candidateForActiveRoute(snapshot);
    if (!active || snapshot.activeRoute.routeHandle === operation.baseline.activeRoute?.routeHandle) {
      return false;
    }
    if (operation.target.kind === "empty-openrouter" || operation.target.kind === "empty-nanogpt") {
      const commit = operation.emptySetupCommit;
      return commit !== null
        && snapshot.revision === commit.revision
        && snapshot.generation === commit.generation
        && snapshot.activeRoute.routeHandle === commit.routeHandle
        && active.handle === commit.routeHandle
        && active.providerId === (operation.target.kind === "empty-nanogpt" ? "nano-gpt" : "openrouter");
    }
    if (operation.target.kind !== "model") return false;
    return active.providerId === operation.target.providerId
      && active.connectionId === operation.target.connectionId
      && active.canonicalModelId === operation.target.canonicalModelId
      && active.handle !== operation.target.selectedHandle;
  };

  const publishOperationFinal = (
    operation: OnboardingOperation,
    result: DesktopOnboardingResult,
  ): void => {
    if (operation.finalPublished || operation.suppressFinal) return;
    operation.finalPublished = true;
    if (result.kind === "view") {
      onboarding = operation.controller;
    } else if (desktopAuthority) {
      onboarding = new DesktopOnboardingController({ authority: desktopAuthority });
    }
    const snapshot = publishDesktop();
    if (!snapshot || result.kind === "view") return;
    desktopActivity(
      result.kind === "ready" ? "setup-completed" : "setup-cancelled",
      result.kind === "ready" ? "Einrichtung abgeschlossen" : "Einrichtung abgebrochen",
      snapshot,
    );
  };

  const requireRunnableDesktopRoute = (): void => {
    const { snapshot } = currentDesktop();
    if (!snapshot.routeRunnable || !snapshot.activeRoute) {
      throw new GuiRequestRefused(
        "route-not-runnable",
        "No current runnable model route is available.",
        "connect a provider and choose a model",
      );
    }
    try {
      const proved = context.providerRuntime.ensureRunnableRoute();
      if (proved.backendId !== "codex") defaultRunSessionDeps.assertModelBoundToRoute(context.config.mainModel, proved);
    } catch {
      throw new GuiRequestRefused(
        "route-proof-stale",
        "The selected model route is no longer runnable.",
        "refresh and choose the model again",
      );
    }
  };

  const desktopSetupSurface = (owner: object, backendId: "openrouter" | "nano-gpt" = "openrouter"): SetupSurface => ({
    // Provider choice is already bound. Nano exposes only its two billing
    // choices here; a foreign entry cannot become a second provider picker.
    chooseHub: async (entries) => {
      if (backendId !== "nano-gpt" || entries.length !== 2
        || entries.some((entry) => entry.id !== "nano-gpt:subscription" && entry.id !== "nano-gpt:payg")) return null;
      return transport.ask("choose-hub", { title: "Nano-GPT · Abrechnung wählen", entries: entries.map((entry) => ({ ...entry, current: false })) },
        null, (answer) => typeof answer.id === "string"
          && entries.some((entry) => entry.id === answer.id && !entry.disabled) ? answer.id : null, owner);
    },
    readSecret: (request) => transport.ask(
      "secret",
      { label: request.message, escHint: "Esc goes back to the provider list" },
      null,
      (answer) => (typeof answer.value === "string" ? answer.value : null),
      owner,
    ),
    chooseModel: (request) => {
      const seen = new Set<string>();
      const models = request.models.filter((model) => {
        if (seen.has(model.canonicalModelId)) return false;
        seen.add(model.canonicalModelId);
        return true;
      });
      return transport.ask(
        "choose-model",
        {
          title: "Choose a model",
          backendId: request.backendId,
          models: models.map((model) => ({
            id: model.canonicalModelId,
            name: setupModelRowLabel(model),
            requestedModelId: model.requestedModelId,
            capabilities: { ...model.capabilities },
          })),
        },
        null,
        (answer) => {
          const id = typeof answer.id === "string" ? answer.id : null;
          return id && models.some((model) => model.canonicalModelId === id) ? id : null;
        },
        owner,
      );
    },
    confirm: (request) => transport.ask(
      "confirm",
      {
        title: request.message,
        consequence: request.consequence ?? "",
        danger: request.danger === true,
        defaultAccept: request.danger === true ? false : request.defaultValue,
      },
      false,
      (answer) => answer.accepted === true,
      owner,
    ),
    // Desktop setup state crosses only as the canonical snapshot/view pair
    // plus typed activity. Legacy setup notices otherwise become durable
    // transcript rows in this adapter, which is precisely what Task 4 removes.
    present() {},
  });
  // m9: fire-and-forget. Awaiting a live HTTPS round trip here delayed the
  // first request read by however long the network took; the balance is a
  // cached figure by contract, and its absence is already honest.
  // Fire-and-forget, and NEVER awaited at teardown. Fix round 1 awaited it
  // there "so no promise outlives the session" — but both outcomes are
  // already handled below, so nothing could go unhandled, and the await sat
  // AHEAD of the final save with no bound at all: a slow or hanging provider
  // read held the exit for as long as the HTTP client's own retries took,
  // defeating SHUTDOWN_DRAIN_MS six lines above it. A balance figure is not
  // worth a hung exit.
  void context.openRouter.checkBalance().then(
    (balance) => { state.balance = balance; },
    () => {
      // `readCachedBalance` keeps returning null and every balance segment is
      // simply omitted — never a fabricated zero.
    },
  );

  /* --- requests -------------------------------------------------------- */

  let finish: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => { finish = resolve; });

  const buildStatus = async (): Promise<GuiStatus> => {
    const activeRoute = context.providerRuntime.readCachedSettingsRoute?.() ?? null;
    const costs = context.session.data.costs;
    // Best-effort, exactly like the dashboard's own `refreshDaySpend`: a
    // failure omits the segment rather than inventing a figure for it.
    const dayUsd = await workspaceSpend(context.workspace, context.session.appHome)
      .then((spend) => spend.dayUsd)
      .catch(() => undefined);
    return {
      model: context.config.mainModel,
      resolvedModel: state.resolvedModel,
      workspace: localRun?.view().originalRoot ?? context.workspace,
      chatId: context.session.data.id,
      chatTitle: context.session.data.title,
      approval: context.approvals.mode,
      // Tri-state: `undefined` when no predicate is wired — claims nothing.
      routeConnected: typeof context.providerRuntime.hasRunnableRoute === "function"
        ? context.providerRuntime.hasRunnableRoute()
        : undefined,
      providerManaged: activeRoute?.backendId === "kimi-code",
      // The dashboard's own figure: remaining credit net of what THIS chat
      // has spent since it was adopted (cli.ts's `spentSinceStart`). Never
      // zeroed when unknown — absent means "not known", which is not the
      // same as free — and `balanceHedged` says it is a cached read.
      balanceRemainingUsd: state.balance?.credits
        ? Math.max(
            0,
            state.balance.credits.remaining
              - Math.max(0, costs.totalUsd - state.startingSessionCost),
          )
        : undefined,
      balanceHedged: true,
      lowBalanceThresholdUsd: context.config.lowBalanceThresholdUsd,
      dayUsd,
      sessionUsd: costs.totalUsd,
      sessionCostKnowledge: costs.costKnowledge === "unknown" ? "unknown" : "known",
      runActive: state.runActive,
      executionMode: executionModeFacts.derived,
      ownerPathsAllowed: executionModeFacts.ownerPathsAllowed,
    } as GuiStatus;
  };

  /**
   * M3: the exclusions the dashboard gets by construction, stated.
   *
   * `TerminalUi.readInput()` does not return while a run streams, a command
   * runs, a modal is up or Settings owns the screen — so the loop can never
   * interleave those. A request-driven surface has no such gate, and each of
   * these collisions is a real defect: two commands share one `guiOut`
   * buffer and the context; a run under an open Settings controller is a
   * state the registry's `runActive` locking is never entered for; and a
   * submit while a confirm is unanswered would start a run behind a question
   * about the previous one.
   */
  const assertSessionIdle = (
    what: string,
    options: { allowCrossRun?: boolean; crossMessage?: boolean; allowSettingsReturn?: boolean } = {},
  ): void => {
    if (state.runActive) {
      throw new GuiRequestRefused(
        "run-active",
        `A run is in flight, so ${what} cannot start.`,
        "cancel, or interject",
      );
    }
    // A Cross run holds the same lane a single-model run holds: two
    // coordinators against one session is a state the runtime's own
    // `run-active` guard would refuse anyway, said here by name instead.
    // The exception is the four commands the dashboard also leaves reachable
    // while Cross runs — `/cross status|stop|off` and `/quit`.
    if (!options.allowCrossRun && context.crossRunActive?.()) {
      throw new GuiRequestRefused(
        "cross-run-active",
        // A plain MESSAGE is the one case both terminal loops already have a
        // sentence for, so it gets that sentence rather than a fourth
        // wording. The other blocked requests (`chat.open`, Settings …) have
        // no terminal counterpart — the dashboard's own input loop cannot
        // reach them mid-Cross at all — so they keep this surface's grammar.
        options.crossMessage
          ? CROSS_RUN_ACTIVE_MESSAGE_NOTICE
          : `A Cross run is in flight, so ${what} cannot start.`,
        "/cross stop",
      );
    }
    // Most specific blocker first: while a command waits on a confirm, both
    // "a command is running" and "a question is open" are true, and only the
    // second tells the owner what to do about it.
    if (transport.pendingAskCount > 0) {
      throw new GuiRequestRefused(
        "question-pending",
        `A question is waiting for an answer, so ${what} cannot start.`,
        "answer it first",
      );
    }
    if (state.commandInFlight) {
      throw new GuiRequestRefused(
        "command-in-flight",
        `A command is still running, so ${what} cannot start.`,
      );
    }
    if (activeSettings) {
      throw new GuiRequestRefused(
        "settings-open",
        `Settings is open, so ${what} cannot start.`,
        "close Settings first",
      );
    }
    if (settingsOnboardingReturn && !options.allowSettingsReturn) {
      throw new GuiRequestRefused(
        "onboarding-active",
        `Provider setup is in flight, so ${what} cannot start.`,
        "cancel setup or wait for it to finish",
      );
    }
    if (onboardingOperation) {
      throw new GuiRequestRefused(
        "onboarding-active",
        `Provider setup is in flight, so ${what} cannot start.`,
        "cancel setup or wait for it to finish",
      );
    }
    if (chatMutationInFlight) {
      throw new GuiRequestRefused(
        "chat-mutation-active",
        `A chat switch is in flight, so ${what} cannot start.`,
      );
    }
  };

  const commandMenuRuntime = (rows: readonly CommandMenuRow[]): CommandMenuRuntime => {
    const crossActive = context.crossRunActive?.() === true;
    const blockedFor = (id: import("./command-catalog.js").SlashCommandHandlerId) =>
      ['architect','collab-cross','collab-cross-run','collab-cross-models'].includes(id) ? desktopCommandDisabled('local-flow-required')
        : state.runActive ? desktopCommandDisabled("run-active")
        : crossActive && !commandAllowedDuringCrossRun(id) ? desktopCommandDisabled("cross-run-active")
        : transport.pendingAskCount > 0 ? desktopCommandDisabled("question-pending")
        : state.commandInFlight ? desktopCommandDisabled("command-in-flight")
        : activeSettings ? desktopCommandDisabled("settings-open")
        : undefined;
    return new Map(rows.flatMap((row) => {
      const id = row.kind === "match" ? row.entry.handlerId : row.kind === "node" ? row.node.handlerId : undefined;
      if (!id) return [];
      const blocked = blockedFor(id as import("./command-catalog.js").SlashCommandHandlerId);
      return [[id, {
        ...(id === "model" && state.resolvedModel ? { currentLabel: state.resolvedModel } : {}),
        ...(blocked ? { disabled: blocked } : {}),
      }]] as const;
    })) as CommandMenuRuntime;
  };

  const claimChatMutation = (what: string): (() => void) => {
    assertSessionIdle(what);
    chatMutationInFlight = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      chatMutationInFlight = false;
    };
  };

  /**
   * m3: the transcript changed in a way an append-only client cannot follow.
   *
   * The dashboard answers `/clear` with `ui.loadTurns([])` and a session
   * swap with `ui.loadTurns(next.recentTurns(...))`. A GUI without an
   * equivalent renders deleted history forever. Derived from what the
   * session HOLDS — a replaced store, or a turn count that went down —
   * never from which command was typed, so no command name is re-derived
   * truth on either side of the pipe.
   */
  const emitTranscriptResync = (
    sessionBefore: typeof context.session,
    turnsBefore: number,
  ): void => {
    const replaced = context.session !== sessionBefore;
    const shrunk = context.session.data.turns.length < turnsBefore;
    if (!replaced && !shrunk) return;
    if (replaced) state.startingSessionCost = context.session.data.costs.totalUsd;
    const reset: GuiChatReset = {
      chatId: context.session.data.id,
      title: context.session.data.title,
      workspace: context.workspace,
      turnCount: context.session.data.turns.length,
      reason: replaced ? "replaced" : "cleared",
    };
    transport.emit("chat.reset", {
      ...reset,
      turns: context.session.recentTurns(VISIBLE_TURNS).map((turn) => ({ ...turn })),
    });
  };

  /**
   * m2: the dashboard re-reads the balance after exactly these commands
   * (cli.ts's post-command block), because each of them can change what the
   * account holds. Serving the startup figure forever would drift from the
   * TUI, which the iron rules call a finding in itself.
   */
  const refreshBalanceAfterCommand = async (completedCommand: string): Promise<void> => {
    try {
      if (completedCommand === "balance" || completedCommand === "reconnect") {
        state.balance = await context.openRouter.checkBalance();
        return;
      }
      if (completedCommand === "key") {
        state.balance = context.openRouter.hasKey
          ? await context.openRouter.checkBalance()
          : null;
      }
    } catch {
      // Honest absence beats a stale number: every balance segment is
      // omitted rather than fabricated when the read fails.
      state.balance = null;
    }
  };

  const openChat = async (selection: ChatSelection): Promise<GuiChatOpened & { opened: boolean }> => {
    const switchContext = await readChatSwitchContext(context);
    if (selection.kind === "existing" && !switchContext.chatById.has(selection.chatId)) {
      throw new GuiRequestRefused("unknown-chat", `No chat with id ${selection.chatId}.`);
    }
    const workspaceBefore = context.workspace;
    pendingTurns = [];
    const opened = await openChatSelection({
      surface: chatSurface,
      context,
      switchContext,
      selection,
    });
    if (opened) {
      // The same chrome reset `runDashboard` does after a switch: a new chat
      // inherits neither the previous one's resolved model nor its pending
      // attachments.
      state.resolvedModel = "";
      state.currentModelInfo = null;
      state.pendingImages = [];
      state.startingSessionCost = context.session.data.costs.totalUsd;
      surface.setImageAttachments([]);
    }
    const frame: GuiChatOpened = {
      chatId: context.session.data.id,
      title: context.session.data.title,
      workspace: context.workspace,
      rerooted: context.workspace !== workspaceBefore,
      turnCount: context.session.data.turns.length,
      // D8c / FIX-20 finding 7: while this holds nothing has been written
      // for the chat, so a client must not expect it in `chats.list`.
      untouched: context.session.isUntouched,
    };
    if (opened) {
      transport.emit("chat.opened", { ...frame, turns: pendingTurns.map((turn) => ({ ...turn })) });
    }
    return { ...frame, opened };
  };

  const dispatchCommand = async (raw: string): Promise<"continue" | "exit"> => {
    const completedCommand = resolveCliCommandName(raw);
    const args = commandArguments(raw);
    // The dashboard intercepts bare `/chat`/`/chats` before dispatch because
    // `chatPickerIo` is stream-shaped and cannot be supplied honestly by a
    // surface that has no stream (G0 §2.2). Falling through would drop the
    // core into raw mode on a pipe. The refusal names the protocol path that
    // does exist rather than pretending.
    if ((completedCommand === "chat" || completedCommand === "chats") && args.length === 0) {
      throw new GuiRequestRefused(
        "terminal-only-picker",
        "The chat picker is a terminal list. Use chats.list to read the rows and chat.open / chat.new to switch.",
      );
    }
    // m7: `/compress model` with no id reaches `pickFromListPlain`, which on
    // a pipe returns null — and the command then reports "Model selection
    // cancelled." Nothing was cancelled: no question was ever asked. The
    // refusal names the surface that CAN ask, which this server already
    // serves end-to-end (the Settings `compressor-model` row).
    if (completedCommand === "compress" && args[0]?.toLowerCase() === "model" && args.length === 1) {
      throw new GuiRequestRefused(
        "terminal-only-picker",
        "The summarizer-model list is a terminal picker. Choose it in Settings, or pass the model id: /compress model <id>.",
      );
    }
    const execute = () => handleSlashCommand(raw, context as never);
    const requiresRoute = commandRequiresRunnableRoute(completedCommand, args, "dashboard");
    return requiresRoute && !commandTransitionsRunnableRoute(completedCommand, args)
      ? context.providerRuntime.runWithReadyRoute(async (route) => {
          if (route.backendId !== "codex") {
            defaultRunSessionDeps.assertModelBoundToRoute(context.config.mainModel, route);
            context.agent = await context.ensureAgentForPrompt(setupSurface);
          }
          return execute();
        }, setupSurface)
      : execute();
  };

  const handle = async (request: GuiRequest): Promise<unknown> => {
    const entryStopEpoch=guiStopEpoch;
    if(request.t==='cancel'){
      guiStopEpoch+=1;localProcessAbort.abort();if(localGrant)localGrant.revoked=true;
      if(localRecovery)return {requested:true};
    }
    if(restoredSessionId!==context.session.data.id && !state.runActive && !localRecovery) {
      const sessionId=context.session.data.id,originalRoot=context.workspace;
      localRecovery=(async()=>{
        if(!localRun){
          const recovered=await LocalProjectRun.restoreLatest({appHome:context.session.appHome,sessionId,originalRoot});
          if(context.session.data.id!==sessionId||context.workspace!==originalRoot)throw new Error('local-recovery-retired');
          if(recovered){
            const rooted=await context.reRootWorkspace?.(recovered.view().workRoot);
            if(!rooted?.ok||context.session.data.id!==sessionId)throw new GuiRequestRefused('local-recovery-blocked','Die gespeicherte Arbeitskopie konnte nicht geöffnet werden. Sie wurde nicht gestartet.');
            localRun=recovered;publishLocal();
          }
        }
        restoredSessionId=sessionId;
      })().finally(()=>{localRecovery=null;});
    }
    if(localRecovery)await localRecovery;
    if(request.t!=='cancel'&&entryStopEpoch!==guiStopEpoch)throw new GuiRequestRefused('local-operation-retired','Die Aktion wurde durch Stop verworfen.');
    switch (request.t) {
      case "submit": {
        const text = typeof request.text === "string" ? request.text.trim() : "";
        if (!text) {
          throw new GuiRequestRefused("empty-submit", "submit needs a non-empty text.");
        }
        // The wire is the boundary, not the window.
        //
        // In the terminal an idle slash line can NEVER become a message: the
        // dashboard's loop dispatches it (`trimmed.startsWith("/")`) and an
        // unknown one is refused, never sent to a model. On a protocol that
        // guarantee cannot live in one client's `if` — a second client, or a
        // regression in this one, would silently turn `/undo` into a paid
        // run, and on an ARMED chat into a paid TWO-model run with the
        // command as the task. So the server refuses it here, ahead of the
        // armed branch and ahead of any spending.
        //
        // `interject` is deliberately NOT guarded: mid-run the terminal
        // feeds every line, slash included, to the running task
        // (tui.ts:4148's `!runOwnsTheLine &&`), so a permissive interject is
        // parity rather than a hole.
        if (text.startsWith("/")) {
          throw new GuiRequestRefused(
            "slash-as-message",
            "A line that begins with \"/\" is a command, not a message.",
            "send it as a command request",
          );
        }
        // M3: the dashboard cannot reach any of these states, because
        // `readInput()` simply does not return while a run, a command, a
        // modal or Settings owns the screen. A request-driven surface has no
        // such loop, so the exclusions are stated instead — each naming the
        // state that blocked it rather than failing generically.
        assertSessionIdle("submit", { crossMessage: true });
        if(localRun?.view().phase==='stopped')throw new GuiRequestRefused('local-run-stopped',
          'Die Arbeitskopie ist gestoppt. Wähle ausdrücklich „Fortsetzen“, bevor du weiterarbeitest.');
        requireRunnableDesktopRoute();
        if(context.providerRuntime.ensureRunnableRoute().backendId==='codex') {
          throw new GuiRequestRefused('codex-isolation-unproven',
            'Codex ist noch nicht für den neuen Arbeitskopie-Ablauf geprüft. Das Hersteller-Terminal bleibt verfügbar.');
        }
        // Phase 10, on this surface too: while the chat is armed, every plain
        // message routes to the SAME Cross entry the one-shot `/cross`
        // command uses — the same `launchCrossRun`, the same run-active
        // blocking, the same one-shot clearing. The shared runtime commits
        // the echo only after its private claim and synchronous coordinator
        // reservation have both succeeded.
        const armedPair = context.session.data.crossMode;
        if (armedPair) {
          throw new GuiRequestRefused('cross-local-copy-unavailable','Bitte Cross deaktivieren. Parallele Rollen sind noch nicht an diesen lokalen Arbeitskopie-Ablauf gebunden.');
        }
        localProcessAbort=new AbortController();
        const processSignal=localProcessAbort.signal;
        state.runActive = true;
        state.runSettled = (async () => {
          const turn = createRunTurnState();
          try {
            if(!localRun || localRun.view().phase==='applied') {
              localRun=await LocalProjectRun.create({originalRoot:localRun?.view().originalRoot??context.workspace,
                appHome:context.session.appHome,sessionId:context.session.data.id,signal:processSignal});
              if(processSignal.aborted){await localRun.stop();publishLocal();throw new Error('local-process-retired');}
              const reroot=await context.reRootWorkspace?.(localRun.view().workRoot);
              if(!reroot?.ok)throw new Error('local-workspace-reroot-failed');
            }
            const run=localRun,epoch=run.view().stopEpoch,routeHandle=currentDesktop().snapshot.activeRoute!.routeHandle;
            const policy={...localPolicy};
            processSignal.throwIfAborted();
            localGrant={id:randomUUID(),revision:policy.revision,revoked:false,workRoot:run.view().workRoot,
              allowedRouteHandles:[routeHandle],allowedActions:['read','edit','test'],extraCostLimitUsd:0};
            await run.start(epoch);publishLocal();
            const assertCurrent=()=>{
              run.assertStart(epoch);
              if(processSignal.aborted||localPolicy.revision!==policy.revision
                ||currentDesktop().snapshot.activeRoute?.routeHandle!==routeHandle)throw new Error('local-process-retired');
              assertLocalRunGrant(localGrant!,{revision:policy.revision,workRoot:context.workspace,routeHandle,
                action:'edit',extraCostUsd:0});
            };
            const perform=async(prompt:string,readonly:boolean)=>{
              assertCurrent();context.approvals.mode=readonly?'read-only':policy.permissions==='automatic'?'auto-edit':'ask';
              context.approvals.setReadOnlyExecutionFence(readonly);
              try{
                const outcome=await runSessionTurn({surface,context,deps:guiRunDeps,ports:runPorts,
                  state:turn,setupSurface,text:prompt});
                if(outcome.kind!=='completed'||outcome.result.outcome!=='completed')throw new Error('local-phase-incomplete');
                return outcome.result.text;
              }finally{context.approvals.setReadOnlyExecutionFence(false);}
            };
            await executeLocalFlow(policy,{assertCurrent,
              plan:()=>perform(`Erstelle ausschließlich einen kurzen Umsetzungsplan. Keine Änderungen und keine Befehle ausführen. Aufgabe:\n${text}`,true),
              approve:async(plan)=>askConfirm('Diesen lokalen Plan umsetzen?',
                `${plan.slice(0,12000)}\n\nNur das von dir gewählte Lead-Modell arbeitet in der Arbeitskopie. Planung verbraucht Kontingent.`,{defaultAccept:false}),
              work:async(plan)=>{await perform(plan?`Setze den freigegebenen Plan für diese Aufgabe um:\n${text}\n\nPlan als Kontext:\n${plan}`:text,false);}});
            if(run.view().phase!=='stopped')await run.review();publishLocal();
          } catch (error) {
            applyRunTurnFailure({
              surface,
              context,
              deps: guiRunDeps,
              ports: runPorts,
              state: turn,
              text,
              error,
            });
          } finally {
            context.approvals.mode=localPolicy.permissions==='automatic'?'auto-edit':'ask';
            if(localRun && localRun.view().phase==='running') {
              await localRun.review().catch(()=>localRun?.stop());publishLocal();
            }
            state.runActive = false;
            publishLocal();
            flushAll();
          }
        })();
        return { started: true };
      }
      case "cancel": {
        manufacturerOperation.abort();
        localProcessAbort.abort();if(localGrant)localGrant.revoked=true;
        if(localRun||state.runActive){cancelHandler?.();transport.abandonPendingAsks();if(localRun)await localRun.stop();publishLocal();return {requested:true};}
        if (!cancelHandler) {
          throw new GuiRequestRefused("no-run", "Nothing is running.");
        }
        cancelHandler();
        // NOT `{cancelled:true}` — cancellation is requested here and
        // decided by the run: a cancelled run always throws (agent.ts:1666-1668)
        // and its `run-end` outcome is `cancelled`, never `complete`.
        return { requested: true };
      }
      case "interject": {
        const text = typeof request.text === "string" ? request.text : "";
        if (!interjectHandler) {
          throw new GuiRequestRefused("no-run", "Nothing is running.");
        }
        if (!text.trim()) {
          throw new GuiRequestRefused("empty-interject", "interject needs a non-empty text.");
        }
        interjectHandler(text);
        return { queued: true };
      }
      case "end-thinking": {
        if (!endThinkingHandler) {
          throw new GuiRequestRefused("no-run", "Nothing is running.");
        }
        endThinkingHandler();
        return { requested: true };
      }
      case "command": {
        const rawCommand=String(request.raw??'').trim();
        const resolvedCommand=resolveSlashCommand(rawCommand);
        if(['architect','cross','collab-cross','collab-cross-run','collab-cross-models'].includes(resolveCliCommandName(rawCommand))) {
          throw new GuiRequestRefused('local-flow-required','Nutze für lokale Aufgaben den AI-Prozess-Schalter und „Aufgabe starten“. Parallele Cross-Ausführung ist noch nicht an Arbeitskopien gebunden.');
        }
        const raw = typeof request.raw === "string" ? request.raw.trim() : "";
        if (!raw.startsWith("/")) {
          throw new GuiRequestRefused("not-a-command", "command needs a slash command.");
        }
        // A command is ONE line. Shift+Enter can put a newline in the
        // composer, and `handleSlashCommand` has never received that shape
        // from the terminal — its dispatcher reads a single input line. A
        // refusal that names the reason beats a command whose arguments
        // silently contain a line break.
        if (/[\r\n]/.test(raw)) {
          throw new GuiRequestRefused(
            "multiline-command",
            "A command is a single line.",
            "remove the line breaks",
          );
        }
        // A Cross run leaves exactly four commands reachable, and says so in
        // the dashboard's own words — one list, one sentence, both surfaces.
        const commandName = resolveCliCommandName(raw);
        const crossActive = context.crossRunActive?.() === true;
        const survivesCrossRun = commandAllowedDuringCrossRun(commandName);
        if (crossActive && !survivesCrossRun) {
          throw new GuiRequestRefused("cross-run-active", CROSS_RUN_ACTIVE_COMMAND_NOTICE);
        }
        if (resolveDesktopOnboardingCommand(raw)) {
          const { snapshot } = currentDesktop();
          await handle({
            v: GUI_PROTOCOL_VERSION,
            t: "onboarding.dispatch",
            intent: {
              kind: "open-model-picker",
              returnTo: "chat",
              revision: snapshot.revision,
              generation: snapshot.generation,
            },
          } as GuiRequest);
          return { outcome: "continue" };
        }
        // M3 (round 2): the same mechanism every other entry point uses.
        // `command` used to check only `runActive` and `commandInFlight`, so
        // it slipped past an open Settings controller and past an unanswered
        // editor ask — the mirror image of the collisions round 1 closed.
        assertSessionIdle("a command", { allowCrossRun: crossActive && survivesCrossRun });
        // The composer's own bytes, handed over exactly once — the same thing
        // `ui.consumeCrossCommandDraft()` does for the dashboard when the
        // palette replaces the composer with a command. Armed AFTER every
        // guard above: a refused command must leave the slot exactly as it
        // found it, or the refusal eats the owner's text.
        if (typeof request.draft === "string") {
          state.commandDraft = request.draft.trim() ? request.draft : null;
        }
        state.commandInFlight = true;
        const sessionBefore = context.session;
        const turnsBefore = context.session.data.turns.length;
        const modelBefore = context.config.mainModel;
        guiOut.flush();
        let outcome: "continue" | "exit";
        try {
          if(resolvedCommand?.handlerId==='folder' && localRun) {
            if(!['applied','stopped'].includes(localRun.view().phase))throw new GuiRequestRefused('local-work-pending','Arbeitskopie erst übernehmen oder stoppen.');
            const rooted=await context.reRootWorkspace?.(localRun.view().originalRoot);
            if(!rooted?.ok)throw new GuiRequestRefused('local-workspace-stale','Der Originalordner konnte nicht geöffnet werden.');
            localRun=null;publishLocal();
          }
          outcome = await dispatchCommand(raw);
        } finally {
          const captured = guiOut.flush();
          if (captured.output) {
            transport.emit("command-output", {
              raw,
              level: captured.level,
              lines: captured.output.split("\n"),
            });
          }
          state.commandInFlight = false;
        }
        emitTranscriptResync(sessionBefore, turnsBefore);
        await refreshBalanceAfterCommand(resolveCliCommandName(raw));
        if (context.config.mainModel !== modelBefore) state.resolvedModel = "";
        if (outcome === "exit") {
          // m6: `/quit` used to answer `{outcome:"exit"}` and change nothing.
          // It is the same intent `shutdown` carries, so it takes the same
          // path — including M1's cancel-and-drain and the process exit.
          transport.afterResponse(() => finish?.());
        }
        return { outcome };
      }
      // The palette is served, not shipped: `resolveCommandMenuRows` is the
      // ONE data path Ctrl+P and inline `/` completion already share in the
      // terminal, and `projectPaletteRow` adds only the Enter verb — from
      // `commandMenuEnterVerb`, the function FIX-11 pinned. A client that
      // computed its own verb from `acceptsArguments` would be the second
      // truth that finding exists to prevent.
      case "catalog.level": {
        const path = Array.isArray(request.path)
          ? (request.path as unknown[]).filter((entry): entry is string => typeof entry === "string")
          : [];
        const state = { path, query: "", selectedIndex: 0 };
        const rows = resolveCommandMenuRows(state);
        return {
          path,
          crumb: [...commandMenuCrumbParts(state)],
          rows: rows.map((row) => projectDesktopPaletteRow(row, commandMenuRuntime(rows))),
          total: rows.length,
        };
      }
      case "catalog.search": {
        const query = typeof request.query === "string" ? request.query : "";
        const state = { path: [], query, selectedIndex: 0 };
        // An empty query browses the root; any other searches every
        // executable leaf globally, ignoring the path — the whole point of a
        // global finder (`resolveCommandMenuRows`).
        const rows = resolveCommandMenuRows(state);
        return {
          query,
          crumb: [...commandMenuCrumbParts(state)],
          rows: rows.map((row) => projectDesktopPaletteRow(row, commandMenuRuntime(rows))),
          total: rows.length,
        };
      }
      case "chats.list": {
        const chats = await listChatsAcrossWorkspaces(
          context.session.appHome,
          context.providerRuntime.migratedSessionConnection(),
        );
        // `ChatSummary.route` carries an `accountFingerprint` into every row
        // (types.ts:307). The projection is what makes the list shippable.
        return { chats: chats.map((chat) => projectChatRow(chat)) };
      }
      case "chat.open": {
        const chatId = typeof request.chatId === "string" ? request.chatId : "";
        if (!chatId) {
          throw new GuiRequestRefused("invalid-chat-id", "chat.open needs a chatId.");
        }
        const release = claimChatMutation("chat.open");
        try {
          if(localRun){
            if(!['applied','stopped'].includes(localRun.view().phase))throw new GuiRequestRefused('local-work-pending','Arbeitskopie erst übernehmen oder stoppen.');
            await context.reRootWorkspace?.(localRun.view().originalRoot);localRun=null;publishLocal();
          }
          if (chatId === context.session.data.id) {
            // Honest rather than a silent no-op: nothing moved, and the client
            // is told which chat it is already on.
            return { opened: false, reason: "already-open", chatId };
          }
          return await openChat({ kind: "existing", chatId });
        } finally {
          release();
        }
      }
      case "chat.new": {
        const release = claimChatMutation("chat.new");
        const title = typeof request.title === "string" && request.title.trim()
          ? request.title.trim()
          : undefined;
        try {
          if(localRun){
            if(!['applied','stopped'].includes(localRun.view().phase))throw new GuiRequestRefused('local-work-pending','Arbeitskopie erst übernehmen oder stoppen.');
            await context.reRootWorkspace?.(localRun.view().originalRoot);localRun=null;publishLocal();
          }
          return await openChat({ kind: "new", ...(title ? { title } : {}) });
        } finally {
          release();
        }
      }
      case "chat.delete": {
        const chatId = typeof request.chatId === "string" ? request.chatId.trim() : "";
        if (!chatId) {
          throw new GuiRequestRefused("invalid-chat-id", "chat.delete needs a chatId.");
        }
        const release = claimChatMutation("chat.delete");
        try {
        // ONE implementation. `/chat delete <id>` already carries the D4
        // danger question with its own copy (`Permanently delete chat "…"?`
        // plus the artifact list), the ambiguity refusal, `SessionStore.remove`
        // and the replaced-session handling. This request is a typed front
        // door onto it, not a second deletion path — so the confirm the client
        // sees is the command's own, word for word.
        const switchContext = await readChatSwitchContext(context);
        const target = switchContext.chatById.get(chatId);
        if (!target) {
          throw new GuiRequestRefused("unknown-chat", `No chat with id ${chatId}.`);
        }
        // Reachability is decided by the SAME lookup the command performs
        // (`SessionStore.list` over the current folder), never by comparing
        // two path strings — `context.workspace` and a stored row's folder
        // can differ by a symlink resolution and still be the same place.
        const here = await SessionStore.list(
          context.workspace,
          context.session.appHome,
          context.providerRuntime.migratedSessionConnection(),
        );
        if (!here.some((chat) => chat.id === chatId)) {
          throw new GuiRequestRefused(
            "foreign-chat",
            `That chat lives in ${target.workspace}, and deletion happens in the chat's own folder.`,
            "open it first, then delete it",
          );
        }
        const sessionBefore = context.session;
        const turnsBefore = context.session.data.turns.length;
        guiOut.flush();
        state.commandInFlight = true;
        try {
          await dispatchCommand(`/chat delete ${chatId}`);
        } finally {
          const captured = guiOut.flush();
          if (captured.output) {
            transport.emit("command-output", {
              raw: `/chat delete ${chatId}`,
              level: captured.level,
              lines: captured.output.split("\n"),
            });
          }
          state.commandInFlight = false;
        }
        emitTranscriptResync(sessionBefore, turnsBefore);
        // Whether it actually went is a fact about the store, never an
        // assumption about the answer: a declined confirm leaves it there.
        const after = await readChatSwitchContext(context);
          return { deleted: !after.chatById.has(chatId), chatId };
        } finally {
          release();
        }
      }
      case "status.get":
        return await buildStatus();
      case "cost.forecast": {
        // Phase 12's own math, fed the same three inputs the dashboard's
        // status line feeds it: the route's cached catalog price, the chat's
        // context chars, and a rolling band over this chat's own recent
        // assistant turns. Display-only — nothing here gates a run.
        const draftChars = typeof request.draftChars === "number"
          && Number.isFinite(request.draftChars)
          ? Math.max(0, Math.floor(request.draftChars))
          : 0;
        const info = state.currentModelInfo;
        if (!info || draftChars === 0) {
          // No resolved model yet, or nothing typed: no segment, never a guess.
          return { kind: "none" } satisfies GuiCostForecast;
        }
        const activeRoute = context.providerRuntime.readCachedSettingsRoute?.() ?? null;
        const forecast = computePromptCostForecast({
          promptChars: contextCharsForForecast(context.session) + draftChars,
          price: classifyCostForecastPrice({
            backendId: activeRoute?.backendId ?? "",
            promptPrice: info.promptPrice,
            completionPrice: info.completionPrice,
          }),
          outputTokenBand: estimateOutputTokenBand(
            context.session.data.turns
              .filter((turn) => turn.role === "assistant")
              .map((turn) => turn.content.length),
          ),
        });
        const text = formatPromptCostForecast(forecast);
        return {
          kind: forecast.kind,
          ...(text === undefined ? {} : { text }),
          ...(forecast.kind === "band"
            ? { minUsd: forecast.minUsd, maxUsd: forecast.maxUsd }
            : {}),
        } satisfies GuiCostForecast;
      }
      case "official-cli.action": {
        const intent = parseOfficialCliRequest(request);
        assertSessionIdle('Hersteller-CLI einrichten',{allowSettingsReturn:true});
        const before = currentDesktop().snapshot;
        if (intent.revision !== before.revision || intent.generation !== before.generation) {
          throw new GuiRequestRefused('onboarding-stale','Die Anbieteransicht ist veraltet. Bitte erneut öffnen.');
        }
        manufacturerOperation.abort();
        manufacturerOperation = new AbortController();
        const signal = manufacturerOperation.signal;
        if (intent.action !== 'check') {
          if (!manufacturerActions) throw new GuiRequestRefused('native-local-action-unavailable',
            'Die Einrichtung benötigt die lokale Desktop-App.');
          await manufacturerActions.beginManufacturerAction({provider:intent.provider,action:intent.action},signal);
          return {kind:'presented',nativeAvailable:true};
        }
        const port = createOfficialCliHostProbe();
        const observed = await probeOfficialCli(intent.provider,intent.revision,port,{signal});
        const after = currentDesktop().snapshot;
        if (signal.aborted || before.revision !== after.revision || before.generation !== after.generation) {
          throw new GuiRequestRefused('onboarding-stale','Die Prüfung wurde durch eine neue Auswahl ersetzt.');
        }
        return {kind:'checked',state:observed,presentation:cliPresentation(observed),nativeAvailable:manufacturerActions !== null};
      }
      case 'execution-policy.set': {
        assertSessionIdle('Ausführungseinstellung ändern');
        if(Object.keys(request).some(key=>!['v','t','id','key','value','revision'].includes(key))
          ||request.v!==GUI_PROTOCOL_VERSION||!['aiProcess','permissions'].includes(String(request.key)))throw new Error('invalid-local-policy-request');
        localPolicy=updateLocalPolicy(localPolicy,request.key as 'aiProcess'|'permissions',String(request.value),Number(request.revision));
        if(localGrant)localGrant.revoked=true;
        context.approvals.mode=localPolicy.permissions==='automatic'?'auto-edit':'ask';
        return publishLocal();
      }
      case 'local-run.action': {
        if(request.v!==GUI_PROTOCOL_VERSION||Object.keys(request).some(key=>!['v','t','id','action','candidateHandle'].includes(key)))throw new Error('invalid-local-action');
        if(request.action==='state')return publishLocal();
        assertSessionIdle('Arbeitskopie prüfen oder übernehmen');
        if(!localRun)throw new GuiRequestRefused('no-local-run','Es gibt noch keine Arbeitskopie.');
        if(request.candidateHandle!==localCandidateHandle)throw new GuiRequestRefused('candidate-stale','Der Arbeitsstand wurde geändert. Bitte erneut prüfen.');
        const run=localRun;
        if(!['resume','apply','test'].includes(String(request.action)))throw new GuiRequestRefused('invalid-local-action','Diese Arbeitskopie-Aktion ist nicht verfügbar.');
        state.commandInFlight=true;
        const actionController=new AbortController();localProcessAbort=actionController;
        const priorCancelHandler=cancelHandler;cancelHandler=()=>actionController.abort();publishLocal();
        try{
        if(request.action==='resume'){
          const rooted=await context.reRootWorkspace?.(run.view().workRoot);
          if(!rooted?.ok)throw new GuiRequestRefused('local-workspace-stale','Die Arbeitskopie konnte nicht geöffnet werden.');
          actionController.signal.throwIfAborted();await run.resume(actionController.signal);return publishLocal();
        }
        if(context.workspace!==run.view().workRoot)throw new GuiRequestRefused('local-workspace-stale','Die Arbeitskopie ist nicht mehr der aktive Arbeitsort.');
        if(request.action==='apply') {
          if(!await askConfirm('Geprüfte Änderungen ins Original übernehmen?',
            'Die Übernahme erfolgt manuell. Schließe andere schreibende Programme für dieses Projekt. Bei Basisänderungen wird abgebrochen.',{danger:true}))return publishLocal();
          await run.apply(localCandidateHash,{confirmed:true});return publishLocal();
        }
        if(request.action==='test') {
          if(!context.config.verify.commands.length)throw new GuiRequestRefused('verify-not-configured','Noch kein Testbefehl hinterlegt. Nutze /verify suggest oder /verify <Befehl>.');
          const candidate=await run.review();actionController.signal.throwIfAborted();
            const outcome=await runVerify(context.config.verify.commands,context.localRuntime.guard,actionController.signal,()=>{},
              {onProcessStart:completion=>emitRunEvent({type:'process-start',...completion,timestamp:Date.now()}),
                onProcessChunk:(operation,stream,text)=>emitRunEvent({type:'process-output',...operation,stream,text,timestamp:Date.now()}),
                onProcessEnd:(operation,completion)=>emitRunEvent({type:'process-end',...operation,...completion,timestamp:Date.now()})});
            if(run.view().phase!=='stopped')await run.markTested(candidate.candidateHash,outcome.status==='passed');
            return {...publishLocal(),verification:outcome.status};
        }
        throw new GuiRequestRefused('invalid-local-action','Diese Arbeitskopie-Aktion ist nicht verfügbar.');
        }finally{state.commandInFlight=false;cancelHandler=priorCancelHandler;publishLocal();}
      }
      case 'project.open': {
        assertSessionIdle('Projekt öffnen');
        if(request.v!==GUI_PROTOCOL_VERSION||typeof request.path!=='string'
          ||Object.keys(request).some(key=>!['v','t','id','path'].includes(key)))throw new Error('invalid-project-open');
        if(localRun && !['applied','stopped'].includes(localRun.view().phase)) {
          throw new GuiRequestRefused('local-work-pending','Die Arbeitskopie zuerst übernehmen oder ausdrücklich stoppen. Sie bleibt gespeichert.');
        }
        const release=claimChatMutation('project.open');
        try{
          const result=await context.reRootWorkspace?.(request.path);if(!result?.ok)throw new GuiRequestRefused('project-open-failed','Der Ordner konnte nicht geöffnet werden.');
          localRun=null;publishLocal();transport.emit('status',{...await buildStatus()});return {opened:true};
        }finally{release();publishLocal();}
      }
      case "desktop.snapshot.get": {
        publishLocal();
        const snapshot = publishDesktop();
        if (!snapshot) {
          throw new GuiRequestRefused(
            "desktop-starting",
            "Provider setup is still starting.",
            "wait for the Desktop snapshot",
          );
        }
        return { snapshot };
      }
      case "onboarding.dispatch": {
        let intent = parseOnboardingIntent(request);
        if (intent.kind === "back" && settingsOnboardingReturn?.atEntry) {
          intent = {
            kind: "cancel",
            revision: intent.revision,
            generation: intent.generation,
          };
        }
        if (intent.kind === "cancel") {
          const captured = onboardingOperation;
          if (!captured) {
            const current = currentDesktop();
            assertSessionIdle("provider setup cancellation", { allowSettingsReturn: true });
            const result = observeSettingsOnboardingResult(
              intent,
              await current.controller.dispatch(intent),
            );
            onboarding = new DesktopOnboardingController({ authority: current.authority });
            publishDesktop();
            desktopActivity(
              "setup-cancelled",
              "Einrichtung abgebrochen",
              current.authority.snapshot(),
            );
            restoreSettingsAfterOnboarding();
            return result;
          }
          if (intent.revision !== captured.baseline.revision
            || intent.generation !== captured.baseline.generation
            || intent.operationHandle !== captured.operationHandle) {
            throw new GuiRequestRefused(
              "onboarding-stale",
              "The setup selection is stale. Refresh and try again.",
            );
          }
          const controllerOperationHandle = captured.controller.snapshot().operationHandle;
          if (controllerOperationHandle !== undefined
            && controllerOperationHandle !== captured.operationHandle) {
            throw new GuiRequestRefused(
              "onboarding-stale",
              "The setup selection is stale. Refresh and try again.",
            );
          }
          const controllerIntent: DesktopOnboardingIntent = controllerOperationHandle === undefined
            ? { kind: "cancel", revision: intent.revision, generation: intent.generation }
            : intent;
          const current = {
            controller: captured.controller,
            authority: desktopAuthority!,
          };
          if (!captured.cancelSettlement) {
            captured.cancelOwnsFinal = true;
            captured.cancelSettlement = (async (): Promise<DesktopOnboardingResult> => {
              try {
                captured.abort.abort(captured.cancellationReason);
                transport.abandonPendingAsks(captured.askOwner);
                const [cancelled, operation] = await Promise.allSettled([
                  current.controller.dispatch(controllerIntent),
                  captured.promise,
                ]);
                const fresh = current.authority.snapshot();
                const committed = operationCommitted(captured, fresh);
                const retainedCodex = captured.target.kind === "empty-codex"
                  && captured.codexRetentionCompleted && operation.status === "fulfilled";
                if (cancelled.status === "rejected" && !committed && !retainedCodex) throw cancelled.reason;
                if (operation.status === "rejected"
                  && operation.reason !== captured.cancellationReason
                  && !committed) {
                  throw operation.reason;
                }
                const result: DesktopOnboardingResult = committed
                  ? {
                      kind: "ready",
                      routeHandle: fresh.activeRoute!.routeHandle,
                      routeRunnable: true,
                    }
                  : {
                      kind: "cancelled",
                      view: new DesktopOnboardingController({ authority: current.authority }).snapshot(),
                    };
                const projected = observeSettingsOnboardingResult(intent, result);
                publishOperationFinal(captured, projected);
                restoreSettingsAfterOnboarding();
                return projected;
              } finally {
                // Retain identity through the current input turn, so already
                // queued Cancel B / operation C cannot observe a false idle
                // gap even when snapshot/final publication throws.
                setImmediate(() => {
                  if (onboardingOperation === captured) onboardingOperation = null;
                });
              }
            })();
          }
          return await captured.cancelSettlement;
        }
        const current = currentDesktop();
        assertSessionIdle("provider setup", { allowSettingsReturn: true });
        const selectedProviders = current.snapshot.providers.filter(
          (provider) => provider.providerId === (intent.kind === "choose-provider" ? intent.providerId : current.controller.snapshot().providerId),
        );
        if (intent.kind === "choose-provider") {
          const selected = selectedProviders.find((provider) => !provider.disabled);
          if (!selected || selected.state === "disabled" || selected.state === "blocked") {
            throw new GuiRequestRefused(
              "provider-unavailable",
              "The selected provider is unavailable.",
            );
          }
          if (intent.providerId !== "openrouter" && selected.connectionId === null
            && !(intent.providerId === "nano-gpt" && context.providerRuntime.runDesktopNanoGptSetup)
            && !(intent.providerId === "codex" && context.providerRuntime.connectDesktopCodex)) {
            throw new GuiRequestRefused(
              "provider-unavailable",
              "This provider cannot be connected from the Desktop yet.",
            );
          }
        }

        const emptyOpenRouter = intent.kind === "choose-provider"
          && intent.providerId === "openrouter"
          && selectedProviders.every((provider) => provider.connectionId === null && provider.routes.length === 0);
        const emptyNanoGpt = intent.kind === "choose-provider" && intent.providerId === "nano-gpt"
          && selectedProviders.every((provider) => provider.connectionId === null && provider.routes.length === 0);
        const emptyCodex = intent.kind === "choose-provider" && intent.providerId === "codex"
          && selectedProviders.every((provider) => provider.connectionId === null && provider.routes.length === 0);
        const modelRouteHandle = intent.kind === "choose-model"
          ? intent.routeHandle
          : intent.kind === "retry"
            ? current.controller.retryRouteHandle()
            : null;
        const modelTarget = modelRouteHandle === null
          ? undefined
          : current.controller.snapshot().candidates.find((candidate) => candidate.handle === modelRouteHandle);
        const target: OnboardingTarget = emptyOpenRouter
          ? { kind: "empty-openrouter" }
          : emptyNanoGpt ? { kind: "empty-nanogpt" }
          : emptyCodex ? { kind: "empty-codex" }
          : modelTarget
            ? {
                kind: "model",
                providerId: modelTarget.providerId,
                connectionId: modelTarget.connectionId,
                canonicalModelId: modelTarget.canonicalModelId,
                selectedHandle: modelTarget.handle,
              }
            : { kind: "navigation" };
        const operation: OnboardingOperation = {
          operationHandle: createDesktopOnboardingOperationHandle(),
          askOwner: Object.freeze({}),
          abort: new AbortController(),
          cancellationReason: new Error("Desktop setup was cancelled by this operation."),
          controller: current.controller,
          baseline: current.snapshot,
          target,
          emptySetupCommit: null,
          codexRetentionCompleted: false,
          promise: Promise.resolve({ kind: "view", view: current.controller.snapshot() }),
          cancelSettlement: null,
          cancelOwnsFinal: false,
          finalPublished: false,
          suppressFinal: false,
        };
        onboardingOperation = operation;
        try {
          if (settingsOnboardingReturn?.suppressOperationOverlay !== true) {
            transport.emit("onboarding.view", {
              view: projectOnboardingView(operation.controller),
            });
          }
        } catch (error) {
          if (onboardingOperation === operation) onboardingOperation = null;
          throw error;
        }
        operation.promise = (async (): Promise<DesktopOnboardingResult> => {
          const runDesktopSetup = emptyOpenRouter
            ? context.providerRuntime.runDesktopOpenRouterSetup
            : emptyNanoGpt ? context.providerRuntime.runDesktopNanoGptSetup
            : undefined;
          if ((emptyOpenRouter || emptyNanoGpt) && !runDesktopSetup) {
            throw new GuiRequestRefused(
              "provider-unavailable",
              `${emptyNanoGpt ? "Nano-GPT" : "OpenRouter"} setup is unavailable in this engine.`,
            );
          }
          if (intent.kind === "choose-provider" || intent.kind === "open-model-picker") {
            desktopActivity("setup-opened", "Einrichtung geöffnet", current.snapshot);
          }
          if (emptyCodex) {
            const method = await askChoice("Mit ChatGPT anmelden", [
              { value: "chatgpt" as const, label: "Im Browser anmelden" },
              { value: "chatgptDeviceCode" as const, label: "Mit Gerätecode anmelden" },
            ], "", "", operation.askOwner);
            if (!method || operation.abort.signal.aborted) {
              return { kind: "cancelled", view: operation.controller.snapshot() };
            }
            try {
              await context.providerRuntime.connectDesktopCodex!(method.value, operation.abort.signal);
            } catch {
              if (operation.abort.signal.aborted) throw operation.abort.signal.reason;
              throw new GuiRequestRefused("codex-login-failed",
                "Die ChatGPT-Anmeldung konnte nicht bestätigt werden.",
                "Anmeldung in der signierten Desktop-App erneut starten");
            }
            operation.codexRetentionCompleted = true;
            // Retaining an account is not model consent. Require a fresh explicit account click.
            const fresh = current.authority.snapshot();
            return operation.controller.dispatch({ kind: "choose-provider", providerId: "codex",
              revision: fresh.revision, generation: fresh.generation }, operation.abort.signal);
          }
          if (emptyOpenRouter || emptyNanoGpt) {
            let legacyError: unknown = null;
            let legacySettlement: unknown = null;
            try {
              legacySettlement = await runDesktopSetup!.call(
                context.providerRuntime,
                desktopSetupSurface(operation.askOwner, emptyNanoGpt ? "nano-gpt" : "openrouter"),
                operation.abort.signal,
              );
            } catch (error) {
              legacyError = error;
              legacySettlement = error;
            }
            operation.emptySetupCommit = (emptyNanoGpt
              ? context.providerRuntime.reconcileDesktopNanoGptSetupCommit?.(legacySettlement)
              : context.providerRuntime.reconcileDesktopOpenRouterSetupCommit?.(legacySettlement)) ?? null;
            const fresh = current.authority.snapshot();
            if (operationCommitted(operation, fresh)) {
              return { kind: "ready", routeHandle: fresh.activeRoute!.routeHandle, routeRunnable: true };
            }
            if (legacyError) throw legacyError;
            return {
              kind: "cancelled",
              view: new DesktopOnboardingController({ authority: current.authority }).snapshot(),
            };
          }
          return await operation.controller.dispatch(
            intent,
            operation.abort.signal,
            operation.operationHandle,
          );
        })();
        try {
          const result = await operation.promise;
          const projected = observeSettingsOnboardingResult(intent, result);
          if (operation.suppressFinal) return projected;
          if (operation.cancelOwnsFinal) return await operation.cancelSettlement!;
          publishOperationFinal(operation, projected);
          if (projected.kind !== "view") restoreSettingsAfterOnboarding();
          return projected;
        } catch (error) {
          if (operation.suppressFinal) throw error;
          if (operation.cancelOwnsFinal) return await operation.cancelSettlement!;
          if (!operation.cancelOwnsFinal && desktopAuthority) {
            onboarding = new DesktopOnboardingController({ authority: desktopAuthority });
            publishDesktop();
          }
          restoreSettingsAfterOnboarding();
          throw error;
        } finally {
          if (!operation.cancelOwnsFinal && onboardingOperation === operation) {
            onboardingOperation = null;
          }
        }
      }
      case "settings.open": {
        const category = typeof request.category === "string"
          ? (request.category as SettingsCategoryId | DesktopSettingsCategoryId)
          : undefined;
        // Settings was guarded against by `submit`, but never guarded ITSELF:
        // opening it during a run produced exactly the "run under an open
        // Settings controller" state the registry's `runActive` locking is
        // never entered for.
        assertSessionIdle("Settings");
        const operation = startSettings(category);
        void operation.completion.catch((error: unknown) => {
          // M2: the same one description path every other failure takes.
          transport.emit("notice", {
            kind: "error",
            message: describeRequestFailure(error, describeError).message,
          });
        });
        return { opened: true };
      }
      case "settings.dispatch": {
        const operation = activeSettings;
        if (!operation) {
          throw new GuiRequestRefused("settings-closed", "Settings is not open.");
        }
        let intent: DesktopSettingsIntent;
        try {
          intent = parseDesktopSettingsIntent(request.intent);
        } catch {
          throw new GuiRequestRefused(
            "invalid-intent",
            "settings.dispatch needs an intent.",
          );
        }
        if (operation.phase === "open" && operation.desktop) {
          const navigation = operation.desktop.navigationFor(intent);
          if (navigation) {
            const paused = operation.desktop.view;
            const { snapshot } = currentDesktop();
            const selectedProvider = navigation.providerId === undefined
              ? []
              : snapshot.providers.filter(({ providerId }) => providerId === navigation.providerId);
            const directProviderAvailable = navigation.providerId !== undefined
              && selectedProvider.some((provider) => (
                provider.disabled === undefined
                && provider.state !== "disabled"
                && provider.state !== "blocked"
              ))
              && (
                navigation.providerId === "openrouter"
                || (navigation.providerId === "nano-gpt" && context.providerRuntime.runDesktopNanoGptSetup !== undefined)
                || selectedProvider.some(({ connectionId }) => connectionId !== null)
              );
            const directProviderHasAccount = directProviderAvailable
              && selectedProvider.some(({ connectionId }) => connectionId !== null);
            const directProviderNeedsSecret = directProviderAvailable
              && (navigation.providerId === "openrouter" || navigation.providerId === "nano-gpt")
              && selectedProvider.every((provider) => (
                provider.connectionId === null && provider.routes.length === 0
              ));
            settingsOnboardingReturn = {
              source: operation,
              restore: {
                selectedCategoryId: paused.selectedCategoryId,
                query: paused.search.query,
                expandedCategoryIds: paused.categories
                  .filter(({ expanded }) => expanded)
                  .map(({ id }) => id),
                focusNavigation: navigation,
              },
              entry: navigation.providerId === undefined
                ? navigation.kind
                : directProviderHasAccount ? "account" : "provider",
              ...(directProviderHasAccount ? { providerId: navigation.providerId } : {}),
              suppressOperationOverlay: directProviderNeedsSecret,
              atEntry: true,
            };
            try {
              await awaitSettingsResponse(operation, requestSettingsClose(operation));
              await handle({
                v: GUI_PROTOCOL_VERSION,
                t: "onboarding.dispatch",
                intent: directProviderAvailable
                  ? {
                      kind: "choose-provider",
                      providerId: navigation.providerId!,
                      revision: snapshot.revision,
                      generation: snapshot.generation,
                    }
                  : {
                      kind: "open-model-picker",
                      returnTo: "chat",
                      revision: snapshot.revision,
                      generation: snapshot.generation,
                    },
              } as GuiRequest);
            } catch (error) {
              if (settingsOnboardingReturn?.source === operation) {
                restoreSettingsAfterOnboarding();
              }
              throw error;
            }
            return { dispatched: intent.kind };
          }
        }
        await awaitSettingsResponse(operation, dispatchSettings(operation, intent));
        return { dispatched: intent.kind };
      }
      case "settings.close": {
        const operation = activeSettings;
        if (!operation) return { closed: false };
        await awaitSettingsResponse(operation, requestSettingsClose(operation));
        return { closed: true };
      }
      case "shutdown": {
        manufacturerOperation.abort();
        // Settings owns a response-bearing FIFO. Settle its exact close lane
        // while the transport is still writable so a pending dispatch/close
        // cannot be silenced by the shutdown response's terminal boundary.
        beginDesktopShutdown();
        const settingsAtShutdown = beginSettingsShutdown();
        if (settingsAtShutdown) {
          const settingsSettlement = settingsAtShutdown.closeSettlement
            ?? settingsAtShutdown.completion;
          const settled = await settleWithinShutdownBound(
            settingsSettlement,
            "Desktop Settings",
          );
          if (!settled) {
            settingsAtShutdown.responseRetired = true;
            finalizeSettingsOperation(settingsAtShutdown);
          }
        }
        // The acknowledgement is the terminal response. Settings responses
        // that settled inside the bound are already on the wire; timed-out
        // ones have explicitly lost response authority and are omitted.
        transport.afterResponse(() => {
          transport.close();
          finish?.();
        });
        return { stopping: true };
      }
      default:
        throw new GuiRequestRefused("unknown-request", `Unknown request: ${request.t}`);
    }
  };

  // The Desktop authority is passive: constructing it reads only local,
  // already-loaded state. It must exist before the deferred provider
  // inspection, whose recovery/probes can legitimately take their full
  // startup budget. Otherwise status.get can already mark the engine ready
  // while every Desktop control still receives `desktop-starting`.
  const authorityFactory = context.providerRuntime.desktopOnboardingAuthority;
  if (!authorityFactory) {
    throw new Error("The Desktop onboarding authority is unavailable.");
  }
  desktopAuthority = authorityFactory.call(context.providerRuntime);
  onboarding = new DesktopOnboardingController({ authority: desktopAuthority });

  transport.start(handle, () => {
    beginDesktopShutdown();
    beginSettingsShutdown();
    finish?.();
  }, () => { publishDesktop(); });
  surface.setStatus("Checking provider …", false);
  publishDesktop();
  try {
    if (typeof context.setupRequired === "function") await context.setupRequired();
    publishDesktop();
  } finally {
    surface.setStatus("Ready", false);
  }
  await closed;

  // M1: stdin EOF means the shell that spawned us is gone (the only reliable
  // parent-death signal on macOS, and the reason D1 chose stdio); `shutdown`
  // and `/quit` mean the owner asked. Either way an in-flight run must STOP,
  // not keep spending into a transport nobody reads — and it must stop the
  // way a user's Esc stops it, through the run's own cancel handler, so the
  // outcome is `cancelled` and never `complete`, the partial text is saved
  // by the run's own commit, and the tool children it spawned into their own
  // process groups (workspace.ts) are killed by the abort rather than
  // orphaned when the shell loses patience and SIGKILLs us.
  if (state.runActive && cancelHandler) {
    cancelHandler();
  }
  const onboardingAtShutdown = onboardingOperation as OnboardingOperation | null;
  const settingsAtShutdown = activeSettings as GuiSettingsOperation | null;
  beginDesktopShutdown();
  beginSettingsShutdown();
  if (onboardingAtShutdown) transport.abandonPendingAsks(onboardingAtShutdown.askOwner);
  const onboardingCancellation = desktopAuthority
    ? desktopAuthority.cancelActivation().catch(() => "none" as const)
    : null;
  // Fix round 1, found while pinning the armed path: a CROSS run is not
  // `state.runActive`, so the block above never saw one — a shell that quit
  // mid-Cross left two model workers spending into a pipe nobody reads,
  // which is precisely the scenario M1 exists to prevent. `stopAndDrainCrossRun`
  // is cli.ts's own stop-then-await pair, used here rather than a second one.
  const crossSettled = activeCrossRun;
  if (crossSettled) {
    void stopAndDrainCrossRun(context.cross, crossSettled);
  }
  if (state.runSettled) {
    // The run settles through `applyRunTurnFailure`, which is what persists
    // the partial and reports the cancellation.
    await settleWithinShutdownBound(state.runSettled, "a run");
  }
  if (crossSettled) {
    await settleWithinShutdownBound(crossSettled, "a Cross run");
  }
  if (onboardingAtShutdown) {
    await settleWithinShutdownBound(
      onboardingAtShutdown.cancelSettlement ?? onboardingAtShutdown.promise,
      "Desktop provider setup",
    );
  }
  if (onboardingCancellation) {
    await settleWithinShutdownBound(onboardingCancellation, "Desktop activation cancellation");
  }
  if (settingsAtShutdown) {
    await settleWithinShutdownBound(
      settingsAtShutdown.closeSettlement ?? settingsAtShutdown.completion,
      "Desktop Settings",
    );
  }
  context.approvals.setPromptHandler(undefined);
  flushAll();
  // Every exit trigger ends here, so the reader is torn down once, whichever
  // one fired: EOF already closed it, `shutdown` and `/quit` close it now.
  transport.close();
  // Exactly one save, under the guard both interactive loops already use:
  // an untouched chat has nothing worth a file (D8c / FIX-20 finding 7).
  if (!context.session.isUntouched) {
    await context.session.save();
  }
}

/**
 * A client-supplied editor result.
 *
 * A `model-route` value is REFUSED on the way in: routes are minted
 * core-side (F1b) and a client that could hand one back would be handing
 * back an identity the protocol never gave it.
 */
function readEditorDecision(answer: Record<string, unknown>): DesktopSettingsEditorDecision {
  const decision = answer.decision;
  if (!decision || typeof decision !== "object") return { kind: "cancel" };
  const value = decision as Record<string, unknown>;
  switch (value.kind) {
    case "cancel":
      return { kind: "cancel" };
    case "choice":
      return typeof value.optionHandle === "string" && value.optionHandle.length <= 200
        ? { kind: "choice", optionHandle: value.optionHandle }
        : { kind: "cancel" };
    case "number":
    case "text":
      return typeof value.value === "string" && [...value.value].length <= 4_096
        ? { kind: value.kind, value: value.value }
        : { kind: "cancel" };
    case "confirm":
      return typeof value.accepted === "boolean"
        ? { kind: "confirm", accepted: value.accepted }
        : { kind: "cancel" };
    case "invoke":
      return { kind: "invoke" };
    default:
      return { kind: "cancel" };
  }
}

/* =========================================================================
 * Entry point
 * ====================================================================== */

export interface GuiServerOptions {
  readonly argv?: readonly string[];
  /** Test seam: the same shape `runCli` already takes. */
  readonly bootstrap?: Partial<CliBootstrapDeps>;
  readonly io?: Partial<GuiTransportIo>;
}

export async function runGuiServer(options: GuiServerOptions = {}): Promise<number> {
  const diagnostic = (text: string): void => {
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  };
  const guard = installStdoutGuard(diagnostic);
  const io: GuiTransportIo = {
    input: options.io?.input ?? process.stdin,
    writeLine: options.io?.writeLine ?? ((line) => guard.writeProtocol(line)),
    diagnostic: options.io?.diagnostic ?? diagnostic,
  };
  const transport = new GuiTransport(io);
  let packagedPermitReader: KimiDesktopPermitReader | null = null;
  transport.hello({
    t: "hello",
    protocol: GUI_PROTOCOL_VERSION,
    orcode: readPackageVersion(),
    node: process.version,
    pid: process.pid,
    capabilities: [...GUI_CAPABILITIES],
    asks: [...GUI_ASK_KINDS],
  });
  // stdout is the protocol; `runCli`'s own writes (a version line, a usage
  // error) go to the diagnostic stream with everything else.
  const streamShim = { write: (chunk: string): boolean => { diagnostic(chunk); return true; } };
  try {
    let desktopKimiCapability = options.bootstrap?.desktopKimiCapability;
    let desktopCodexNativeLogin = options.bootstrap?.desktopCodexNativeLogin;
    if (desktopKimiCapability === undefined && process.env.ORCODE_GUI_SHELL === "tauri" && options.io === undefined) {
      try {
        const nativeChannel = NativeSidecarChannel.fromFixedDescriptors();
        packagedPermitReader = new KimiDesktopPermitReader(nativeChannel);
        const attestation = await packagedPermitReader.consumePackagedStartup(250);
        desktopCodexNativeLogin = Object.freeze({ channel: nativeChannel, childGeneration: attestation.generation });
        desktopKimiCapability = createDesktopKimiRuntimeCapability(attestation, {
          permitReader: packagedPermitReader,
          childPid: process.pid,
          generation: attestation.generation,
          now: Date.now,
          emitRequirement: (requirement) => emitSecretlessNativeLocalActionRequirement(transport, requirement),
        });
      } catch {
        packagedPermitReader?.close("restart");
        packagedPermitReader = null;
        desktopCodexNativeLogin = undefined;
      }
    }
    return await runCli(options.argv ?? [], {
      ...defaultCliBootstrapDeps,
      ...options.bootstrap,
      interactiveSurface: true,
      runDashboard: (input) => runGuiSession(input, transport, io),
      stdout: streamShim,
      stderr: options.bootstrap?.stderr ?? streamShim,
      ...(desktopKimiCapability === undefined ? {} : { desktopKimiCapability }),
      ...(desktopCodexNativeLogin === undefined ? {} : { desktopCodexNativeLogin }),
    });
  } catch (error) {
    // Same rule as every other outbound failure: `error.message` is where
    // provider bodies and request ids live, and this one is emitted before
    // any `openRouter` exists to classify it. Startup stderr is diagnostic,
    // not a promise to preserve unsafe provider detail.
    diagnostic(
      `orcode-gui: the engine failed to start: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }\n`,
    );
    transport.emit("fatal", {
      code: "engine-failed",
      message: "The engine failed to start.",
    });
    return 1;
  } finally {
    packagedPermitReader?.close("end");
    transport.close();
    if (guard.strayWrites > 0) {
      diagnostic(
        `orcode-gui: ${guard.strayWrites} write(s) were kept off the protocol stream.`,
      );
    }
    guard.restore();
  }
}

const invokedDirectly = process.argv[1]
  && (process.argv[1].endsWith("gui-server.js") || process.argv[1].endsWith("gui-server.ts"));
if (invokedDirectly) {
  process.exitCode = await runGuiServer({ argv: process.argv.slice(2) });
}
