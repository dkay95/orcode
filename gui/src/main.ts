/**
 * The controller: it owns no truth, it only asks for one and draws what
 * comes back.
 *
 * The order of operations is the protocol's, not a convenience:
 *
 *   spawn → `hello` (the engine is SPEAKING) → `hello-ack`
 *         → first successful `status.get` (the engine is READY)
 *         → `chats.list` → the window.
 *
 * Nothing draws before that last step, because before it there is no
 * workspace, no session and no provider answer to draw from.
 *
 * Desktop v2 changed the SHAPE, not the rules: the hub screen became a
 * permanent sidebar, the ●/⎿ stream became cards, and the panels became
 * dialogs. Every fact still comes off the wire, every consent point still
 * defaults to the safe answer, and no core logic moved in here.
 */

import "./styles.css";

import { AskQueue, declineAnswer, type PendingAsk } from "./asks.js";
import { routeCoreBrand } from "./brand.js";
import {
  createCrossActionHandlers,
  EngineBridge,
  RequestFailed,
  type BridgeHandlers,
  type EngineInfo,
} from "./bridge.js";
import { ChatModel, type Block } from "./chat-model.js";
import {
  INITIAL_DESKTOP_STATE,
  reduceDesktopState,
  type DesktopState,
} from "./desktop-state.js";
import { el, replace } from "./dom.js";
import { updateMessageMarkdown } from "./message-markdown.js";
import { classifyFailure, describeEngineFailure } from "./failures.js";
import {
  INITIAL_ENGINE_STATE,
  engineHeadline,
  engineStatusWord,
  reduceEngine,
  type EngineState,
} from "./engine-state.js";
import { hubRows, statusSegments, type HubRow, type StatusSegments } from "./hub-model.js";
import {
  OverlayManager,
  type OverlayHandle,
} from "./overlay-manager.js";
import { onboardingView } from "./onboarding-view.js";
import type {Manufacturer,ManufacturerAction,ManufacturerObservation} from './official-cli-panel.js';
import {executionControls,candidatePanel,type LocalWorkbenchState} from './execution-controls.js';
import {
  emptyPalette,
  movePalette,
  palettePanel,
  type PaletteLevel,
  type PalettePanel,
  type PaletteRow,
  type PaletteState,
} from "./palette.js";
import type {
  ChatRow,
  CostForecast,
  DesktopActivity,
  DesktopCapabilitySnapshot,
  DesktopCrossPreflightView,
  DesktopOnboardingResult,
  DesktopOnboardingView,
  DesktopOnboardingIntent,
  DesktopSettingsIntent,
  DesktopSettingsView,
  EventFrame,
  GuiPaletteRow,
  GuiStatus,
  ServerFrame,
} from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { routeComposerLine } from "./routing.js";
import { normalizeCatalogQuery, slashCompletionPanel, type SlashCompletionState } from "./slash-complete.js";
import { settingsContent, settingsHeader } from "./settings-view.js";
import { sidebar } from "./sidebar.js";
import { SessionSurface } from "./surface.js";
import { createWorkbenchPanel } from "./workbench-panel.js";
import {
  askPanel,
  blockSignature,
  chatHeader,
  crossPanel,
  crossPreflightPanel,
  enginePanel,
  renderBlock,
  statusBar,
} from "./views.js";

export interface DesktopWindowBridge {
  chooseProject?():Promise<string|null>;
  start(handlers: BridgeHandlers): Promise<EngineInfo>;
  request<T = unknown>(t: string, payload?: Record<string, unknown>): Promise<T>;
  write(frame: Record<string, unknown>): Promise<void>;
}

export interface MountDesktopWindowOptions {
  readonly bridge: DesktopWindowBridge;
  readonly root: HTMLElement;
}

export interface DesktopWindowMount {
  dispose(): void;
}

function createProductionBridge(): DesktopWindowBridge {
  let engineBridge: EngineBridge | null = null;
  const current = (): EngineBridge => {
    if (!engineBridge) throw new Error("The engine bridge has not started.");
    return engineBridge;
  };
  return {
    chooseProject:()=>current().chooseProject(),
    async start(handlers) {
      engineBridge ??= new EngineBridge(handlers);
      return await engineBridge.start();
    },
    request<T = unknown>(t: string, payload: Record<string, unknown> = {}) {
      return current().request<T>(t, payload);
    },
    write(frame) {
      return current().write(frame);
    },
  };
}

/* --- state ------------------------------------------------------------- */

let engine: EngineState = INITIAL_ENGINE_STATE;
let desktop: DesktopState = INITIAL_DESKTOP_STATE;
let info: EngineInfo | null = null;
/**
 * Which surface owns the engine's session.
 *
 * Two screens now — the sidebar is a place, not a screen you leave to — and
 * WHICH of the two is showing is the engine's answer, never a click's. See
 * `surface.ts` for the defect that rule exists for.
 */
const surface = new SessionSurface({ back: () => closeSettings() });
/** The engine's own Settings view model, or null while Settings is closed. */
let settings: DesktopSettingsView | null = null;
type SettingsFocusAnchor =
  | Readonly<{ kind: "row"; key: string }>
  | Readonly<{ kind: "category"; id: string }>
  | Readonly<{ kind: "more"; id: string }>;
interface PendingSettingsDispatch {
  readonly intent: DesktopSettingsIntent;
  readonly context: MountAsyncContext;
  responseSettled: boolean;
  acceptedRevision: number | null;
  escapeBack: boolean;
}
let pendingSettingsDispatch: PendingSettingsDispatch | null = null;
let queuedSettingsSearch: string | null = null;
let settingsSearchDraft: string | null = null;
let settingsFocusAnchor: SettingsFocusAnchor | null = null;
let settingsRequestError: string | null = null;
/** Allows one authoritative opening view; closed-session replays stay retired. */
let settingsAwaitingView = true;
let nextSettingsCommandViewExpectation = 0;
const settingsCommandViewExpectations = new Set<number>();
let chats: readonly ChatRow[] = [];
let chat = new ChatModel();
/** Secretless projection for the one currently open Cross gate, if any. */
let crossPreflight: DesktopCrossPreflightView | null = null;
const asks = new AskQueue();
/** Remembered across the engine's death, so the consequence can be named. */
let runWasActive = false;
let handshakeStarted = false;
/** What the composer held when a command replaced it. Handed over once. */
let pendingCommandDraft: string | null = null;
/** The engine's pre-submit cost band for the current draft, or null. */
let forecast: string | null = null;
let forecastRequestGeneration = 0;

let mounted = false;
let activeMountGeneration = 0;
let nextMountGeneration = 0;

function isCurrentMount(generation: number): boolean {
  return mounted && activeMountGeneration === generation;
}

interface MountAsyncContext {
  readonly generation: number;
  readonly bridge: DesktopWindowBridge;
}

function captureMountContext(): MountAsyncContext | null {
  if (!mounted) return null;
  return { generation: activeMountGeneration, bridge };
}

function isCurrentMountContext(context: MountAsyncContext): boolean {
  return isCurrentMount(context.generation) && bridge === context.bridge;
}

function createBridgeHandlers(generation: number): BridgeHandlers {
  return {
    onFrame: (frame) => {
      if (isCurrentMount(generation)) handleFrame(frame);
    },
    onUnparseable: () => {
      if (!isCurrentMount(generation)) return;
      engine = reduceEngine(engine, { kind: "unparseable" });
      schedule();
    },
    onExit: (code, signal, cause) => {
      if (!isCurrentMount(generation)) return;
      retireOnboardingForEngineStop();
      resetSettingsClientState(false);
      // Every open question is CLOSED, never answered: an auto-accepted
      // approval would authorize a write nobody agreed to.
      for (const dropped of asks.abandonAll()) {
        pushShellNotice(
          "warn",
          `The engine stopped before the "${dropped.kind}" question could be answered.`,
        );
      }
      engine = reduceEngine(engine, { kind: "exited", code, signal, cause });
      handshakeStarted = false;
      schedule();
    },
    onFailure: (code) => {
      if (!isCurrentMount(generation)) return;
      retireOnboardingForEngineStop();
      resetSettingsClientState(false);
      // A code, not the operating system's own words: the raw text stayed on
      // the shell's stderr (`lib.rs`), and this is the sentence for it.
      const body = describeEngineFailure(code);
      engine = reduceEngine(engine, {
        kind: "spawn-failed",
        code: body.code,
        message: body.message,
        ...(body.hint ? { hint: body.hint } : {}),
      });
      schedule();
    },
  };
}

let bridge!: DesktopWindowBridge;
let bridgeHandlers!: BridgeHandlers;

/* --- the DOM skeleton --------------------------------------------------- */

let root!: HTMLElement;
let sideNode!: HTMLElement;
let mainPane!: HTMLElement;
let headSlot!: HTMLElement;
let contentSlot!: HTMLElement;
let composerSlot!: HTMLElement;
let statusSlot!: HTMLElement;
let sizeHint!: HTMLElement;
let workbenchPanel!: ReturnType<typeof createWorkbenchPanel>;
let inspectorOpen = false;
let navigationOpen = false;
let navigationToggle!: HTMLButtonElement;
let navigationShade!: HTMLButtonElement;
let workspaceName!: HTMLElement;
let toolbarBrand!: HTMLElement;
let workbenchRequestPending = false;
let manufacturerStates:Partial<Record<Manufacturer,ManufacturerObservation>> = {};
let manufacturerNativeAvailable = false;
let manufacturerBusy = false;
let localWorkbench:LocalWorkbenchState={policy:{aiProcess:'manual',permissions:'ask',revision:1},candidate:null};
async function changeExecutionPolicy(key:'aiProcess'|'permissions',value:string):Promise<void> {
  const context=captureMountContext();if(!context||workbenchBusy())return;
  try{const result=await context.bridge.request<LocalWorkbenchState>('execution-policy.set',
    {key,value,revision:localWorkbench.policy.revision});
    if(isCurrentMountContext(context)){localWorkbench=result;headSignature='';schedule();}}
  catch(error){if(isCurrentMountContext(context))reportEngineError(error);}
}
async function localCandidateAction(action:'test'|'apply'|'resume'):Promise<void> {
  const context=captureMountContext(),candidate=localWorkbench.candidate;
  if(!context||!candidate||workbenchBusy())return;
  workbenchRequestPending=true;schedule();
  try{await context.bridge.request('local-run.action',{action,candidateHandle:candidate.candidateHandle});}
  catch(error){if(isCurrentMountContext(context))reportEngineError(error);}
  finally{if(isCurrentMountContext(context)){workbenchRequestPending=false;headSignature='';barSignature='';schedule();}}
}
async function openNativeProject():Promise<void> {
  const context=captureMountContext();if(!context||workbenchBusy())return;
  if(!context.bridge.chooseProject){dispatchCommand('/folder');return;}
  try{const path=await context.bridge.chooseProject();
    if(!path||!isCurrentMountContext(context))return;
    await context.bridge.request('project.open',{path});await refreshStatus(context);}
  catch(error){if(isCurrentMountContext(context))reportEngineError(error);}
}
async function manufacturerAction(provider:Manufacturer,action:ManufacturerAction):Promise<void> {
  const context = captureMountContext(), snapshot = desktop.snapshot;
  if (!context || !snapshot || manufacturerBusy) return;
  manufacturerBusy = true; schedule();
  try {
    const result = await context.bridge.request<ManufacturerObservation|{kind:'presented';nativeAvailable:boolean}>(
      'official-cli.action',{provider,action,revision:snapshot.revision,generation:snapshot.generation});
    if (!isCurrentMountContext(context) || desktop.snapshot?.revision !== snapshot.revision
      || desktop.snapshot?.generation !== snapshot.generation) return;
    manufacturerNativeAvailable = result.nativeAvailable;
    if (result.kind === 'checked') manufacturerStates = {...manufacturerStates,[provider]:result};
    else pushShellNotice('info','Herstellerfenster geöffnet. Nach Installation oder Anmeldung erneut „Prüfen“ wählen.');
  } catch (error) {if (isCurrentMountContext(context)) reportEngineError(error);}
  finally {if (isCurrentMountContext(context)) {manufacturerBusy=false; overlayKey=null; schedule();}}
}
let workbenchDraftCapture: { text: string; editGeneration: number } | null = null;

interface ShellLayoutState {
  readonly tooSmall: boolean;
}

let streamRoot!: HTMLElement;
const streamNodes = new Map<string, { node: HTMLElement; signature: string }>();
/**
 * The live Cross panel's slot, at the foot of the stream — the same place the
 * dashboard appends it. Its own node rather than a block, because it is not
 * transcript: it comes and goes with the run and leaves nothing behind.
 */
let crossSlot!: HTMLElement;
/** Shown while a chat holds nothing yet, so an empty stream is never a lie. */
let emptyStream!: HTMLElement;

let composer!: HTMLTextAreaElement;
let composerBar!: HTMLElement;
let composerBox!: HTMLElement;
let slashCompletion: SlashCompletionState | null = null;
let slashCompletionRequestGeneration = 0;
let paletteRequestGeneration = 0;
let composerEditGeneration = 0;

let overlayManager: OverlayManager | null = null;
let overlayHandle: OverlayHandle | null = null;
/** The owner deliberately opened onboarding; boot-time passive views stay hidden. */
let onboardingVisible = false;
/** A fresh open must not briefly repaint the previous passive view. */
let onboardingAwaitingView = false;
/** The production control that must receive focus when the guided flow closes. */
let onboardingTrigger: HTMLElement | null = null;

export function mountDesktopWindow(
  { bridge: nextBridge, root: nextRoot }: MountDesktopWindowOptions,
): DesktopWindowMount {
  if (mounted) throw new Error("The Desktop window is already mounted.");
  resetDesktopWindowState();
  mounted = true;
  const generation = ++nextMountGeneration;
  activeMountGeneration = generation;
  bridge = nextBridge;
  bridgeHandlers = createBridgeHandlers(generation);
  root = nextRoot;
  root.classList.add("workbench-shell");
  inspectorOpen = false;
  navigationOpen = window.innerWidth >= 900;
  document.documentElement.lang = "de";
  overlayManager = new OverlayManager(root, document.body);

  sideNode = el("aside", { class: "side", id: "workspace-navigation" });
  mainPane = el("section", { class: "main" });
  navigationToggle = el("button", {
    class: "iconbtn navigation-toggle", type: "button", text: "Projekt und Chats",
    "aria-controls": "workspace-navigation", "aria-expanded": String(navigationOpen),
  }) as HTMLButtonElement;
  navigationToggle.addEventListener("click", () => setNavigationOpen(!navigationOpen));
  workspaceName = el("span", { class: "workspace-name" });
  toolbarBrand = routeCoreBrand("chat-header");
  toolbarBrand.hidden = true;
  const toolbar = el("nav", { class: "workspace-toolbar", "aria-label": "Arbeitsbereich" }, [
    navigationToggle, workspaceName, el("span", { class: "spacer" }), toolbarBrand,
  ]);
  navigationShade = el("button", {
    class: "navigation-shade", type: "button", "aria-label": "Navigation schließen", tabindex: "-1",
  }) as HTMLButtonElement;
  navigationShade.addEventListener("click", () => setNavigationOpen(false, true));
  headSlot = el("div");
  contentSlot = el("div", { class: "content" });
  composerSlot = el("div");
  statusSlot = el("div");
  sizeHint = el("div", { class: "size-hint", role: "status", text: "Fenster vergrößern" });
  mainPane.append(toolbar, headSlot, contentSlot, composerSlot, statusSlot);
  workbenchPanel = createWorkbenchPanel({
    command: (raw) => void runWorkbenchCommand(raw),
    close: () => setInspectorOpen(false, true),
  });
  root.replaceChildren(sideNode, mainPane, workbenchPanel.node, navigationShade);
  updateShellLayout();
  window.addEventListener("resize", updateShellLayout);

  streamRoot = el("div", { class: "stream" });
  crossSlot = el("div");
  emptyStream = el("div", { class: "stream-empty" });
  composer = el("textarea", {
    rows: "1",
    spellcheck: "false",
    placeholder: "Was soll im Projekt geändert werden?",
    "aria-label": "Aufgabe oder Nachricht",
  }) as HTMLTextAreaElement;
  composerBar = el("div", { class: "bar" });
  composerBox = el("div", { class: "composer" }, [composer, composerBar]);

  installInputHandlers();
  void boot();

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!isCurrentMount(generation)) return;
      mounted = false;
      activeMountGeneration = 0;
      window.removeEventListener("resize", updateShellLayout);
      uninstallInputHandlers();
      nextRoot.replaceChildren();
      nextRoot.classList.remove("workbench-shell", "workbench-inspector-open", "navigation-open", "navigation-closed", "shell-too-small");
      resetDesktopWindowState();
    },
  };
}

function resetDesktopWindowState(): void {
  clearEngineHelloDeadline();
  localWorkbench={policy:{aiProcess:'manual',permissions:'ask',revision:1},candidate:null};
  manufacturerStates={};manufacturerNativeAvailable=false;manufacturerBusy=false;
  if (frameRequestId !== null) {
    window.cancelAnimationFrame(frameRequestId);
    frameRequestId = null;
  }
  if (forecastTimer !== null) {
    window.clearTimeout(forecastTimer);
    forecastTimer = null;
  }
  overlayManager?.destroy();
  overlayManager = null;
  overlayHandle = null;
  onboardingVisible = false;
  onboardingAwaitingView = false;
  onboardingTrigger = null;

  engine = INITIAL_ENGINE_STATE;
  desktop = INITIAL_DESKTOP_STATE;
  info = null;
  surface.reset();
  settings = null;
  resetSettingsClientState();
  chats = [];
  chat = new ChatModel();
  crossPreflight = null;
  crossSnapshotRevision = 0;
  asks.abandonAll();
  runWasActive = false;
  handshakeStarted = false;
  pendingCommandDraft = null;
  workbenchRequestPending = false;
  workbenchDraftCapture = null;
  inspectorOpen = false;
  navigationOpen = false;
  forecast = null;
  forecastRequestGeneration += 1;
  openChatId = null;
  pendingResume = null;

  streamNodes.clear();
  sideSignature = null;
  headSignature = null;
  settingsSignature = null;
  barSignature = null;
  statusSignature = null;
  palette = null;
  crossSignature = null;
  overlayKey = null;
  palettePanelHandle = null;
  slashCompletion = null;
  slashCompletionRequestGeneration += 1;
  paletteRequestGeneration += 1;
  composerEditGeneration += 1;
  emptyAppearanceSignature = null;
}

function updateShellLayout(): void {
  if (!mounted) return;
  const layout: ShellLayoutState = {
    tooSmall: window.innerWidth < 360 || window.innerHeight < 400,
  };
  root.classList.toggle("shell-too-small", layout.tooSmall);
  if (layout.tooSmall) root.append(sizeHint);
  else sizeHint.remove();
  renderNavigation();
}

function renderNavigation(): void {
  const compactOpen = navigationOpen && window.innerWidth < 900;
  sideNode.hidden = !navigationOpen;
  sideNode.setAttribute("role", compactOpen ? "dialog" : "navigation");
  if (compactOpen) sideNode.setAttribute("aria-modal", "true");
  else sideNode.removeAttribute("aria-modal");
  const close = sideNode.querySelector<HTMLButtonElement>(".navigation-close");
  if (close) close.hidden = window.innerWidth >= 900;
  mainPane.inert = compactOpen;
  workbenchPanel.node.inert = compactOpen;
  root.classList.toggle("navigation-open", navigationOpen);
  root.classList.toggle("navigation-closed", !navigationOpen);
  navigationToggle.setAttribute("aria-expanded", String(navigationOpen));
  navigationShade.hidden = !navigationOpen || window.innerWidth >= 900;
}

function setNavigationOpen(open: boolean, restoreFocus = false): void {
  navigationOpen = open;
  renderNavigation();
  if (open && window.innerWidth < 900) {
    sideNode.querySelector<HTMLButtonElement>(".navigation-close")?.focus();
  }
  if (restoreFocus) navigationToggle.focus();
}

function closeCompactNavigation(): void {
  if (window.innerWidth < 900) setNavigationOpen(false, true);
}

/* --- frames ------------------------------------------------------------- */

function handleFrame(frame: ServerFrame): void {
  engine = reduceEngine(engine, { kind: "frame", frame });
  if (frame.t === "hello") {
    clearEngineHelloDeadline();
    if (engine.phase !== "failed" && !handshakeStarted) {
      handshakeStarted = true;
      void handshake();
    }
  } else if (frame.t === "event") {
    applyEvent(frame);
  } else if (frame.t === "ask") {
    asks.push(frame);
  }
  schedule();
}

function applyEvent(frame: EventFrame): void {
  if(frame.e==='local-run.state'){
    localWorkbench={policy:frame.policy as LocalWorkbenchState['policy'],candidate:frame.candidate as LocalWorkbenchState['candidate'],active:frame.active===true};
    headSignature='';barSignature='';
  }
  chat.apply(frame);
  if (frame.e === "cross") {
    crossSnapshotRevision += 1;
    if (Object.hasOwn(frame, "preflight")) {
      crossPreflight = (frame.preflight as DesktopCrossPreflightView | null) ?? null;
    }
  }
  if (frame.e === "desktop.snapshot") {
    const incoming=frame.snapshot as DesktopCapabilitySnapshot;
    if(desktop.snapshot && (desktop.snapshot.revision!==incoming.revision||desktop.snapshot.generation!==incoming.generation)) {
      manufacturerStates={};manufacturerNativeAvailable=false;
    }
    const hadOnboarding = desktop.onboarding !== null;
    const next = reduceDesktopState(desktop, {
      kind: "snapshot",
      snapshot: frame.snapshot as DesktopCapabilitySnapshot,
    });
    desktop = next;
    // An epoch advance retires the view whose revision-bound controls were
    // on screen. The next accepted operation view may open the flow again;
    // a stale view cannot keep an obsolete dialog alive.
    if (hadOnboarding && next.onboarding === null) {
      onboardingVisible = false;
      onboardingAwaitingView = false;
    }
  }
  if (frame.e === "onboarding.view") {
    const candidate = frame.view as DesktopOnboardingView;
    const before = desktop;
    const next = reduceDesktopState(before, {
      kind: "onboarding",
      view: candidate,
    });
    desktop = next;
    const accepted = next !== before && next.onboarding === candidate;
    if (accepted && candidate.returnTo === "settings") settingsAwaitingView = true;
    if (accepted && candidate.operationHandle) {
      onboardingAwaitingView = false;
      if (!onboardingVisible) {
        onboardingTrigger = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      }
      onboardingVisible = true;
    }
    if (accepted && candidate.step === "ready") {
      onboardingVisible = false;
      onboardingAwaitingView = false;
    }
  }
  if (frame.e === "activity") {
    desktop = reduceDesktopState(desktop, {
      kind: "activity",
      activity: frame.activity as DesktopActivity,
    });
  }
  if (frame.e === "settings.view") {
    const candidate = frame.view as DesktopSettingsView;
    const opensExpectedSession = settings === null
      && !surface.settingsOpen
      && (settingsAwaitingView || settingsCommandViewExpectations.size > 0);
    const advancesCurrentSession = settings !== null
      && surface.settingsOpen
      && candidate.revision > settings.revision;
    if (opensExpectedSession || advancesCurrentSession) {
      settings = candidate;
      settingsAwaitingView = false;
      settingsRequestError = null;
      surface.viewArrived();
      if (
        pendingSettingsDispatch
        && candidate.revision > pendingSettingsDispatch.intent.revision
      ) {
        pendingSettingsDispatch.acceptedRevision = candidate.revision;
      }
      if (candidate.initialFocusKey) {
        settingsFocusAnchor = { kind: "row", key: candidate.initialFocusKey };
      }
      settleSettingsDispatchIfReady();
    }
  }
  if (frame.e === "settings.closed") {
    settings = null;
    resetSettingsClientState(false);
    // The view model goes first: whatever was queued behind the close runs
    // inside `closed()`, and it must not see a stale Settings still standing.
    surface.closed();
    // The appearance and every other saved value live in the config the
    // engine just wrote; the status bar reads them from `status.get`.
    void refreshStatus();
  }
  if (frame.e === "chat.opened" || frame.e === "chat.reset") {
    // The surface is deliberately NOT moved here: the engine refuses
    // `chat.open` while Settings holds the session, so a chat can only open
    // on a surface that is already the chat one. Moving it here would be this
    // side deciding again.
    // Remembered so a restart can put the same transcript back.
    if (typeof frame.chatId === "string") openChatId = frame.chatId;
    // `rerooted` means the whole runtime moved folder. The engine says so
    // itself, in its own words, through the `status` event `openChatSelection`
    // already emits — so nothing is written here. What the flag changes is
    // what has to be RE-READ: the status bar's folder and every sidebar row,
    // which are now about a different workspace.
    void refreshStatus();
    if (frame.e === "chat.reset" || frame.rerooted === true) void refreshChats();
  }
  if (frame.e === "draft") {
    // The engine put text back in the composer: a cancelled Cross gate
    // handing the captured draft back, `/recover continue`, or `/panel use
    // <n>`. The dashboard replaces its input line outright, and so does this
    // — otherwise a refusal silently eats what was typed.
    //
    // `fallback` is the one exception, and it is the terminal's own rule:
    // the gate's PENDING TASK (never a captured draft) may only land in an
    // empty composer, so it can never overwrite something typed while the
    // gate was open (`restoreCrossCommandDraft`'s fallback branch).
    const text = typeof frame.text === "string" ? frame.text : "";
    if (frame.reason === "fallback" && composer.value.trim().length > 0) return;
    // A gate may return the captured task while the owner has already typed
    // the next one. The old task still exists, but cannot replace that edit.
    if (frame.reason === "restore" && workbenchDraftCapture?.text === text
      && composerEditGeneration !== workbenchDraftCapture.editGeneration) return;
    composer.value = text;
    composerEditGeneration += 1;
    invalidateForecast();
    scheduleForecast();
    autosize();
    if (text) queueMicrotask(() => composer.focus());
  }
  if (frame.e === "run") {
    const event = frame.event as { type?: string } | undefined;
    if (event?.type === "run-start") runWasActive = true;
    if (event?.type === "run-end") {
      runWasActive = false;
      void refreshStatus();
    }
  }
}

/* --- requests ----------------------------------------------------------- */

/**
 * Which chat the window was showing, so a restart can put it back.
 *
 * Remembered across the engine's death for the same reason `runWasActive` is:
 * the process that knew it is gone, and a restart that dropped the owner into
 * an empty chat would be showing a transcript that does not exist.
 */
let openChatId: string | null = null;
let engineHelloTimer:number|null=null;
function clearEngineHelloDeadline():void {
  if(engineHelloTimer!==null){window.clearTimeout(engineHelloTimer);engineHelloTimer=null;}
}

async function boot(options: { restart?: boolean } = {}): Promise<void> {
  const context = captureMountContext();
  if (!context) return;
  const activeBridgeHandlers = bridgeHandlers;
  const resumeChatId = options.restart ? openChatId : null;
  engine = reduceEngine(engine, { kind: "spawned" });
  desktop = INITIAL_DESKTOP_STATE;
  onboardingVisible = false;
  onboardingAwaitingView = false;
  onboardingTrigger = null;
  handshakeStarted = false;
  chat = new ChatModel();
  streamNodes.clear();
  replace(streamRoot, []);
  // A restart is a NEW engine, and nothing carries over but what the previous
  // one had already written to disk — including any action that was waiting
  // for the dead engine's Settings session to close.
  surface.reset();
  settings = null;
  resetSettingsClientState();
  clearEngineHelloDeadline();
  engineHelloTimer=window.setTimeout(()=>{
    engineHelloTimer=null;
    if(!isCurrentMountContext(context)||engine.phase!=='starting')return;
    engine=reduceEngine(engine,{kind:'spawn-failed',code:'engine-start-timeout',
      message:'Die Engine antwortet nicht. Es wurde kein Auftrag gestartet.',
      hint:'Prüfe den Dateizugriff der App auf den Projektordner und starte die Engine erneut. Es werden keine Zugriffsrechte automatisch geändert.'});
    schedule();
  },10000);
  schedule();
  try {
    const nextInfo = await context.bridge.start(activeBridgeHandlers);
    if (!isCurrentMountContext(context)) return;
    info = nextInfo;
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    clearEngineHelloDeadline();
    engine = reduceEngine(engine, startFailure(error));
    schedule();
    return;
  }
  if (options.restart) {
    // The handshake is in flight; queue the resume behind it rather than
    // racing it. `handshake()` reaches readiness, and only then is there a
    // chat list to open anything from.
    pendingResume = { chatId: resumeChatId };
  }
  schedule();
}

/** What a restart should put back on screen once the new engine is ready. */
let pendingResume: { chatId: string | null } | null = null;

/**
 * Rebuilds the session view after a restart — or says why it could not.
 *
 * `chat.open` is the same request the sidebar's own row uses, so the
 * transcript comes off the wire rather than being reconstructed from what this
 * window happened to still hold. A chat the new engine cannot reach (it was
 * never saved, or its folder is gone) is not silently swapped for another: the
 * owner is told which chat did not come back.
 */
async function resumeAfterRestart(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context || !isCurrentMountContext(context)) return;
  const resume = pendingResume;
  pendingResume = null;
  if (!resume) return;
  pushShellNotice(
    "info",
    "A new engine is running. Nothing was carried over from the old one — anything it had not saved is gone.",
  );
  if (!resume.chatId) return;
  try {
    await context.bridge.request("chat.open", { chatId: resume.chatId });
    if (!isCurrentMountContext(context)) return;
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    // The honest fallback: the engine's own new session, and the reason.
    reportEngineError(error);
    pushShellNotice("warn", "The chat that was open could not be reopened.");
  }
  schedule();
}

/**
 * A failure to START an engine, in words rather than in a stack.
 *
 * `classifyFailure` decides what may be shown at all: the engine's own
 * refusal and the shell's own refusal are sentences someone wrote for a
 * person; anything else is an exception, and an exception's text goes to
 * the console, never onto the screen.
 */
function startFailure(error: unknown): {
  kind: "spawn-failed";
  message: string;
  hint?: string;
  code?: string;
} {
  const body = classifyFailure(error, "start");
  return {
    kind: "spawn-failed",
    code: body.code,
    message: body.message,
    ...(body.hint ? { hint: body.hint } : {}),
  };
}

async function handshake(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  try {
    await context.bridge.request("hello-ack", { protocol: PROTOCOL_VERSION, client: "orcode-gui" });
    if (!isCurrentMountContext(context)) return;
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    engine = reduceEngine(engine, startFailure(error));
    schedule();
    return;
  }
  await refreshStatus(context);
  if (!isCurrentMountContext(context)) return;
  if (engine.phase === "ready") {
    await refreshDesktopSnapshot(context);
    if (!isCurrentMountContext(context)) return;
  }
  await refreshChats(context);
  if (!isCurrentMountContext(context)) return;
  await resumeAfterRestart(context);
}

async function refreshDesktopSnapshot(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  try {
    await context.bridge.request("desktop.snapshot.get");
    if (!isCurrentMountContext(context)) return;
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    if (engine.phase !== "stopped") reportEngineError(error);
  }
  schedule();
}

async function refreshStatus(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  try {
    const status = await context.bridge.request<GuiStatus>("status.get");
    if (!isCurrentMountContext(context)) return;
    // The readiness gate, and the only thing that opens it.
    engine = reduceEngine(engine, { kind: "status", status });
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    if (engine.phase !== "stopped") reportEngineError(error);
  }
  schedule();
}

async function refreshChats(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  try {
    const result = await context.bridge.request<{ chats: ChatRow[] }>("chats.list");
    if (!isCurrentMountContext(context)) return;
    chats = result.chats ?? [];
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    if (engine.phase !== "stopped") reportEngineError(error);
  }
  schedule();
}

function armOnboardingOpen(): void {
  onboardingVisible = true;
  onboardingAwaitingView = true;
  onboardingTrigger = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

function retireOnboardingForEngineStop(): void {
  onboardingVisible = false;
  onboardingAwaitingView = false;
  onboardingTrigger = null;
}

function openRoutePicker(returnTo: "chat" | "model-picker"): void {
  const context = captureMountContext();
  const snapshot = desktop.snapshot;
  if (!context || !snapshot) return;
  armOnboardingOpen();
  const intent: DesktopOnboardingIntent = {
    kind: "open-model-picker",
    returnTo,
    revision: snapshot.revision,
    generation: snapshot.generation,
  };
  dispatchOnboarding(intent, context);
  schedule();
}

function dispatchOnboarding(
  intent: DesktopOnboardingIntent,
  context: MountAsyncContext | null = captureMountContext(),
): void {
  if (!context || !onboardingVisible || engine.phase === "stopped" || engine.phase === "failed") return;
  void context.bridge.request<DesktopOnboardingResult>("onboarding.dispatch", { intent })
    .then((result) => {
      if (!isCurrentMountContext(context)) return;
      if (result?.kind === "ready" || result?.kind === "cancelled") {
        onboardingVisible = false;
        onboardingAwaitingView = false;
      }
      schedule();
    })
    .catch((error: unknown) => {
      if (!isCurrentMountContext(context)) return;
      onboardingVisible = false;
      onboardingAwaitingView = false;
      reportEngineError(error);
      schedule();
    });
}

async function openChat(
  chatId: string,
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  try {
    await context.bridge.request("chat.open", { chatId });
    if (!isCurrentMountContext(context)) return;
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    reportEngineError(error);
  }
  schedule();
}

async function newChat(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  try {
    await context.bridge.request("chat.new", {});
    if (!isCurrentMountContext(context)) return;
    void refreshChats(context);
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    reportEngineError(error);
  }
  schedule();
}

async function submit(): Promise<void> {
  if (workbenchRequestPending && !chat.runActive) return;
  const context = captureMountContext();
  if (!context) return;
  const activeComposer = composer;
  const text = composer.value.trim();
  if (!text) return;
  const route = routeComposerLine(text, chat.runActive);
  if(route==='submit'&&(workbenchBusy()||localWorkbench.candidate?.phase==='stopped'))return;
  composer.value = "";
  invalidateForecast();
  slashCompletion = null;
  slashCompletionRequestGeneration += 1;
  const submittedClearGeneration = ++composerEditGeneration;
  if(route==='submit'){workbenchRequestPending=true;workbenchDraftCapture={text,editGeneration:submittedClearGeneration};}
  autosize();
  schedule();
  try {
    // The dashboard's own split, as one function (`routeComposerLine`):
    // mid-run every line interjects, slash included; otherwise a leading `/`
    // is a command and never a message. The engine refuses a slash `submit`
    // on the wire too — this side is belt, the wire is the boundary.
    if (route === "interject") await context.bridge.request("interject", { text });
    else if (route === "command") await runCommand(text, context);
    else await context.bridge.request("submit", { text });
    if (!isCurrentMountContext(context)) return;
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    // The engine's own refusal, with its own words: a run in flight, a
    // question waiting, Settings open.
    if (composerEditGeneration === submittedClearGeneration && activeComposer.value === "") {
      activeComposer.value = text;
      autosize();
      scheduleForecast();
      if (route === "command") void refreshSlashCompletion();
    }
    reportEngineError(error);
  }
  if(route==='submit')workbenchRequestPending=false;
  schedule();
}

/**
 * A slash command, dispatched the way the dashboard dispatches one.
 *
 * The engine runs it through `handleSlashCommand` — the same entry point,
 * the same runnable-route gate — so `/undo`'s D4 confirmation, `/diff`'s
 * output and `/chat delete`'s danger question all arrive here as the asks
 * and events they already are. Nothing about a command is re-implemented on
 * this side; this only decides that a line beginning with `/` is one.
 */
async function runCommand(
  raw: string,
  context: MountAsyncContext | null = captureMountContext(),
  draftOverride?: string,
): Promise<void> {
  if (!context) return;
  // The composer's own bytes, handed over exactly once. `/cross` and bare
  // `/architect` run against whatever the owner had typed before reaching for
  // the command — the dashboard's `consumeCrossCommandDraft`, on this side.
  //
  // Always sent, including as `""`: a command the owner TYPED has no
  // separate draft (the composer held the command itself), and an absent
  // field would leave a slot from an earlier capture armed.
  const draft = draftOverride ?? pendingCommandDraft ?? "";
  pendingCommandDraft = null;
  // `/settings`, its category forms and its catalog aliases are resolved by
  // the engine's one command parser. While this exact trusted request is in
  // flight, its authoritative `settings.view` may open the closed surface.
  // The bounded token avoids copying that parser into the WebView and is
  // retired as soon as the request settles, so later/stale views stay out.
  const settingsViewExpectation = settings === null && !surface.settingsOpen
    ? (nextSettingsCommandViewExpectation += 1)
    : null;
  if (settingsViewExpectation !== null) {
    settingsCommandViewExpectations.add(settingsViewExpectation);
  }
  try {
    const result = await context.bridge.request<{ outcome?: string }>("command", { raw, draft });
    if (!isCurrentMountContext(context)) return;
    if (result?.outcome === "exit") {
      // `/quit` is the same intent `shutdown` carries; the engine ends itself
      // and the shell follows it down. Nothing to draw but the honest state.
      engine = reduceEngine(engine, { kind: "quitting" });
    }
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    // A refused command must leave the owner exactly as it found them: the
    // engine has not armed its slot (it arms after every guard), so the
    // capture belongs back here.
    if (draftOverride === undefined) pendingCommandDraft = draft || null;
    throw error;
  } finally {
    if (settingsViewExpectation !== null) {
      settingsCommandViewExpectations.delete(settingsViewExpectation);
    }
  }
  schedule();
}

/**
 * A command raised by a control rather than typed. Same path, same rules —
 * and, since review M1, the same discipline about which surface it needs.
 *
 * It does NOT move the screen. `assertSessionIdle` refuses a command while
 * Settings holds the session, so this asks the controller to hand the session
 * back first and dispatches once the engine says it has. The window can no
 * longer end up on a screen the engine disagrees with.
 */
function dispatchCommand(raw: string): void {
  surface.run(() => {
    void runCommand(raw).catch((error: unknown) => reportEngineError(error));
  });
}

/** These are real engine commands, not a second client-side task workflow. */
function workbenchBusy(): boolean {
  return workbenchRequestPending || localWorkbench.active===true || chat.runActive || chat.cross?.active === true
    || crossPreflight !== null || asks.current !== null;
}

async function runWorkbenchCommand(raw: string): Promise<void> {
  const context = captureMountContext();
  if (!context || engine.phase !== "ready" || workbenchBusy() || surface.settingsOpen) return;
  if (raw === "/undo" && desktop.snapshot?.undoAvailable !== true) return;
  workbenchRequestPending = true;
  schedule();
  try {
    await runCommand(raw, context, "");
  } catch (error) {
    if (isCurrentMountContext(context)) reportEngineError(error);
  } finally {
    if (isCurrentMountContext(context)) {
      workbenchRequestPending = false;
      schedule();
    }
  }
}

function setInspectorOpen(open: boolean, restoreFocus = false): void {
  const context = captureMountContext();
  inspectorOpen = open;
  schedule();
  if (restoreFocus && context) requestAnimationFrame(() => {
    if (!isCurrentMountContext(context)) return;
    root.querySelector<HTMLElement>(open ? ".workbench-close" : ".workbench-toggle")?.focus();
  });
}

async function cancelRun(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  try {
    await context.bridge.request("cancel", {});
    if (!isCurrentMountContext(context)) return;
    // NOT "cancelled": cancellation is requested here and decided by the
    // run, which always ends as `cancelled`, never `complete`.
    chat.status = { text: "Cancel requested …", busy: true };
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    reportEngineError(error);
  }
  schedule();
}

async function endThinking(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  try {
    await context.bridge.request("end-thinking", {});
    if (!isCurrentMountContext(context)) return;
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    reportEngineError(error);
  }
  schedule();
}

/* --- Settings ------------------------------------------------------------ */

/**
 * Settings runs a real `SettingsController` session inside the engine. This
 * side opens it, forwards intents, and draws the view model it sends back —
 * it holds no copy of any setting.
 */
async function openSettings(
  category?: string,
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  // Already there. The engine would answer "Settings is already open." and
  // the refusal would land in a stream nobody can see from this screen; a
  // control that repeats where you already are does nothing on purpose.
  if (surface.settingsOpen) return;
  settingsAwaitingView = true;
  try {
    await context.bridge.request("settings.open", category ? { category } : {});
    if (!isCurrentMountContext(context)) return;
  } catch (error) {
    if (!isCurrentMountContext(context)) return;
    settingsAwaitingView = false;
    reportEngineError(error);
  }
  schedule();
}

function dispatchSettings(
  intent: DesktopSettingsIntent,
  focus: SettingsFocusAnchor | null = captureSettingsFocusAnchor(),
): void {
  if (intent.kind === "search-change") settingsSearchDraft = intent.query;
  if (pendingSettingsDispatch) {
    if (intent.kind === "search-change") queuedSettingsSearch = intent.query;
    return;
  }
  const context = captureMountContext();
  if (!context) return;
  settingsRequestError = null;
  if (focus) settingsFocusAnchor = focus;
  const pending: PendingSettingsDispatch = {
    intent,
    context,
    responseSettled: false,
    acceptedRevision: null,
    escapeBack: false,
  };
  pendingSettingsDispatch = pending;
  void context.bridge.request("settings.dispatch", { intent }).then(() => {
    if (!isCurrentMountContext(context) || pendingSettingsDispatch !== pending) return;
    pending.responseSettled = true;
    settleSettingsDispatchIfReady();
  }).catch(() => {
    if (!isCurrentMountContext(context) || pendingSettingsDispatch !== pending) return;
    pendingSettingsDispatch = null;
    queuedSettingsSearch = null;
    settingsSearchDraft = null;
    settingsFocusAnchor = null;
    showSettingsRequestError();
  });
}

function settleSettingsDispatchIfReady(): void {
  const pending = pendingSettingsDispatch;
  const current = settings;
  if (!pending || !pending.responseSettled || pending.acceptedRevision === null || !current) return;
  pendingSettingsDispatch = null;
  if (pending.escapeBack) {
    queuedSettingsSearch = null;
    settingsSearchDraft = null;
    dispatchSettings({ kind: "back", revision: current.revision }, null);
    return;
  }
  const search = queuedSettingsSearch;
  queuedSettingsSearch = null;
  if (search !== null && search !== current.search.query) {
    dispatchSettings({ kind: "search-change", query: search, revision: current.revision }, null);
    return;
  }
  if (settingsSearchDraft === current.search.query) settingsSearchDraft = null;
}

function captureSettingsFocusAnchor(): SettingsFocusAnchor | null {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const row = active?.dataset.settingsFocusKey;
  if (row) return { kind: "row", key: row };
  const category = active?.dataset.settingsCategory;
  if (category) return { kind: "category", id: category };
  const more = active?.dataset.settingsMore;
  if (more) return { kind: "more", id: more };
  return null;
}

function resetSettingsClientState(awaitOpeningView = true): void {
  pendingSettingsDispatch = null;
  queuedSettingsSearch = null;
  settingsSearchDraft = null;
  settingsFocusAnchor = null;
  settingsRequestError = null;
  settingsAwaitingView = awaitOpeningView;
  settingsCommandViewExpectations.clear();
}

function showSettingsRequestError(): void {
  settingsRequestError = "Änderung fehlgeschlagen · erneut versuchen";
  settingsSignature = null;
  schedule();
}

function closeSettings(): void {
  const context = captureMountContext();
  if (!context) return;
  void context.bridge.request("settings.close")
    .catch(() => {
      if (!isCurrentMountContext(context)) return;
      surface.abandon();
      showSettingsRequestError();
    });
}

function backSettings(): void {
  const current = settings;
  if (!current) return;
  if (pendingSettingsDispatch) {
    if (
      pendingSettingsDispatch.intent.kind === "search-change"
      || pendingSettingsDispatch.intent.kind === "toggle-advanced"
    ) {
      pendingSettingsDispatch.escapeBack = true;
      queuedSettingsSearch = null;
      settingsSearchDraft = null;
    }
    return;
  }
  const selected = current.categories.find(({ id }) => id === current.selectedCategoryId);
  if (current.search.active || selected?.expanded) {
    dispatchSettings({ kind: "back", revision: current.revision });
  } else {
    closeSettings();
  }
}

function answerAsk(ask: PendingAsk, answer: Record<string, unknown>): void {
  const context = captureMountContext();
  if (!context) return;
  if (!asks.resolve(ask.askId)) return;
  void context.bridge.write(answer).catch((error: unknown) => {
    if (!isCurrentMountContext(context)) return;
    if (ask.kind === "settings-editor" && surface.settingsOpen) showSettingsRequestError();
    else reportEngineError(error);
  });
  schedule();
}

/* --- notices ------------------------------------------------------------ */

function reportEngineError(error: unknown): void {
  const body = classifyFailure(error, "request");
  // A refusal from the engine is a warning about a state; anything the
  // window had to classify itself is an error it could not explain.
  const level = error instanceof RequestFailed ? "warn" : "error";
  pushShellNotice(level, body.hint ? `${body.message} — ${body.hint}` : body.message);
}

function pushShellNotice(level: "info" | "warn" | "error", message: string): void {
  chat.apply({ t: "event", v: PROTOCOL_VERSION, e: "notice", kind: level, message } as EventFrame);
}

/* --- rendering ---------------------------------------------------------- */

let frameRequestId: number | null = null;
function schedule(): void {
  if (!mounted || frameRequestId !== null) return;
  frameRequestId = requestAnimationFrame(() => {
    frameRequestId = null;
    if (!mounted) return;
    render();
  });
}

let sideSignature: string | null = null;
let headSignature: string | null = null;
let settingsSignature: string | null = null;
let barSignature: string | null = null;
let statusSignature: string | null = null;

function render(): void {
  const ready = engine.phase === "ready";
  const status = engine.status;
  const home = info?.home ?? null;
  const segments = ready && status ? statusSegments(status, home) : null;

  renderSidebar(segments, status, ready);
  renderNavigation();
  const workspace = status?.workspace ?? "";
  workspaceName.textContent = workspace.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "Kein Projekt geöffnet";
  workspaceName.title = workspace;
  toolbarBrand.hidden = desktop.snapshot?.appearance.showHeaderMark !== true;
  const showInspector = ready && !surface.settingsOpen && inspectorOpen;
  root.classList.toggle("workbench-inspector-open", showInspector);
  workbenchPanel.node.hidden = !showInspector;
  workbenchPanel.update({
    blocks: chat.blocks,
    run: chat.run,
    workspace: status?.workspace ?? "",
    ready: ready && !surface.settingsOpen,
    busy: workbenchBusy(),
    undoAvailable: desktop.snapshot?.undoAvailable === true,
  });

  if (!ready) {
    headSignature = null;
    settingsSignature = null;
    // While it is starting, the content zone says so. Once it has failed or
    // stopped, the dialog carries the whole story and repeating half of it
    // behind it would just be noise.
    replace(headSlot, []);
    replace(contentSlot, [
      engine.phase === "starting" || engine.phase === "speaking"
        ? el("div", { class: "stream-empty", text: engineHeadline(engine) })
        : null,
    ]);
    composerBox.remove();
    replace(composerSlot, []);
  } else if (surface.settingsOpen && settings) {
    // Rebuilt only when the view model itself changed: the search field on
    // this screen is a field a person types into.
    const showSettingsHeaderMark = desktop.snapshot?.appearance.showHeaderMark === true;
    const signature = JSON.stringify([settings, showSettingsHeaderMark, settingsRequestError]);
    if (signature !== settingsSignature) {
      settingsSignature = signature;
      headSignature = null;
      const caret = document.activeElement instanceof HTMLInputElement
        && document.activeElement.classList.contains("settings-search")
        ? document.activeElement.selectionStart
        : null;
      const header = settingsHeader(settings, { dispatch: dispatchSettings, close: closeSettings });
      replace(headSlot, [header]);
      replace(contentSlot, [
        settingsContent(
          settings,
          { dispatch: dispatchSettings, close: closeSettings },
          {
            ...(settingsSearchDraft !== null ? { searchDraft: settingsSearchDraft } : {}),
            ...(settingsRequestError ? { requestError: settingsRequestError } : {}),
          },
        ),
      ]);
      const field = contentSlot.querySelector<HTMLInputElement>(".settings-search");
      if (caret !== null) {
        field?.focus();
        field?.setSelectionRange(caret, caret);
      } else if (settings.search.active && document.activeElement !== field) {
        // The search owns the keyboard while it is active — the terminal's
        // own rule. Without this the `/` key would start a search nothing
        // could be typed into.
        field?.focus();
      }
    }
    replace(composerSlot, []);
  } else {
    settingsSignature = null;
    renderChatHead(segments, status?.chatTitle ?? "");
    // Mounted once, not re-attached per frame: detaching the stream would
    // reset the scroll position, and detaching the composer would blur it —
    // which, at one render per 30 ms of streaming, means a person could not
    // type while the model answers.
    if (contentSlot.firstChild !== streamRoot) replace(contentSlot, [streamRoot, crossSlot]);
    renderStream();
    renderCrossPanel();
    if (composerBox.parentNode !== composerSlot) replace(composerSlot, [composerBox]);
    renderSlashCompletion();
    renderComposerBar();
  }

  renderStatusBar(segments, ready);
  renderOverlay();
  if (ready && surface.settingsOpen && settings) restoreSettingsFocus();
}

function restoreSettingsFocus(): void {
  const anchor = settingsFocusAnchor;
  if (!anchor) return;
  let target: HTMLElement | undefined;
  if (anchor.kind === "row") {
    target = [...contentSlot.querySelectorAll<HTMLElement>("[data-settings-focus-key]")]
      .find((node) => node.dataset.settingsFocusKey === anchor.key);
  } else if (anchor.kind === "category") {
    target = [...contentSlot.querySelectorAll<HTMLElement>("[data-settings-category]")]
      .find((node) => node.dataset.settingsCategory === anchor.id);
  } else {
    target = [...contentSlot.querySelectorAll<HTMLElement>("[data-settings-more]")]
      .find((node) => node.dataset.settingsMore === anchor.id);
  }
  settingsFocusAnchor = null;
  target?.focus();
}

function renderSidebar(
  segments: StatusSegments | null,
  status: GuiStatus | null,
  ready: boolean,
): void {
  const rows: readonly HubRow[] = hubRows(chats, status?.workspace ?? "", info?.home ?? null, Date.now());
  const setupNeeded = desktop.snapshot?.routeRunnable === false;
  /*
   * Rebuilt only when its own facts change: a status event must not take the
   * keyboard focus off the row a person is about to click.
   *
   * Review m2: the signature reads the WIRE PAYLOAD, not the rendered rows.
   * A rendered row carries `relativeAge`'s reading of the clock, so keying on
   * it meant a minute tick alone rebuilt the whole `<aside>` through
   * `replaceWith` and dropped any focus inside it — the exact protection the
   * old hub's frozen-clock signature bought (re-review F6) and which this
   * comment was still claiming while the code no longer provided it. Every
   * real data change (a new chat, a cost, a title, a folder, a model) is a
   * change to `chats`; the ages then update at the next real change, which is
   * the same trade the hub made.
   */
  const signature = JSON.stringify([
    chats,
    status?.chatId ?? "",
    status?.workspace ?? "",
    segments?.folder ?? "",
    setupNeeded,
    surface.settingsOpen,
    ready,
    desktop.snapshot?.revision ?? null,
    desktop.snapshot?.generation ?? null,
  ]);
  if (signature === sideSignature) return;
  sideSignature = signature;
  const next = sidebar(
    rows,
    {
      openChat: (id) => { closeCompactNavigation(); surface.run(() => void openChat(id)); },
      newChat: () => { closeCompactNavigation(); surface.run(() => void newChat()); },
      // Through the one command path, so `/provider setup`'s asks and
      // `/folder`'s D4 confirm arrive as the asks they already are.
      run: (command) => { closeCompactNavigation(); if(command==='/folder')void openNativeProject();else dispatchCommand(command); },
      connect: () => { closeCompactNavigation(); openRoutePicker("chat"); },
      openSettings: () => { closeCompactNavigation(); void openSettings(); },
    },
    {
      activeChatId: status?.chatId ?? null,
      total: chats.length,
      folder: segments?.folder ?? "",
      workspace: status?.workspace ?? "",
      showBrand: false,
      setupNeeded,
      settingsOpen: surface.settingsOpen,
      // Review i3: before the engine is ready there is nothing behind any of
      // these rows, and their refusals would land in a stream this screen is
      // not showing. A control that cannot act says so by being disabled.
      ready,
    },
  );
  const close = el("button", {
    class: "iconbtn navigation-close", type: "button", text: "Navigation schließen",
  });
  close.addEventListener("click", () => setNavigationOpen(false, true));
  next.prepend(close);
  sideNode.replaceWith(next);
  sideNode = next;
  sideNode.id = "workspace-navigation";
}

function renderChatHead(segments: StatusSegments | null, title: string): void {
  const showHeaderMark = false;
  const activeRoute = desktop.snapshot?.activeRoute ?? null;
  const routeRunnable = desktop.snapshot?.routeRunnable ?? null;
  const signature = JSON.stringify([
    title,
    segments?.session ?? "",
    activeRoute,
    routeRunnable,
    showHeaderMark,
    inspectorOpen,
    localWorkbench,
    workbenchBusy(),
  ]);
  if (signature === headSignature) return;
  headSignature = signature;
  const header = chatHeader(
      title,
      segments,
      { activeRoute, routeRunnable },
      { pickRoute: openRoutePicker },
      showHeaderMark,
    );
  const toggle = el("button", {
    class: "chip workbench-toggle", type: "button", text: "Änderungen",
    "aria-controls": "workbench-panel", "aria-expanded": String(inspectorOpen),
    title: "Änderungen und Ausführungen ein- oder ausblenden",
  });
  toggle.addEventListener("click", () => setInspectorOpen(!inspectorOpen, true));
  header.append(toggle);
  header.append(executionControls(localWorkbench,workbenchBusy(),{
    change:(key,value)=>void changeExecutionPolicy(key,value),stop:()=>void bridge.request('cancel').catch(reportEngineError)}));
  replace(headSlot, [header]);
}

function renderStatusBar(segments: StatusSegments | null, ready: boolean): void {
  const text = ready ? chat.status.text || "Bereit" : engineStatusWord(engine);
  const signature = JSON.stringify([segments, text, chat.status.busy]);
  if (signature === statusSignature) return;
  statusSignature = signature;
  const next = statusBar(segments, text, chat.status.busy);
  const current = statusSlot.querySelector<HTMLElement>(".statusbar");
  if (!current) { replace(statusSlot, [next]); return; }
  const currentDetails = current.querySelector<HTMLDetailsElement>(".status-details");
  const nextDetails = next.querySelector<HTMLDetailsElement>(".status-details");
  if (currentDetails && nextDetails) {
    const content = currentDetails.querySelector(".status-details-content")!;
    content.replaceChildren(...nextDetails.querySelector(".status-details-content")!.childNodes);
  }
  syncControlChildren(current, [...next.children].map((node) =>
    node === nextDetails && currentDetails ? currentDetails : node));
}

/** Update the chrome without detaching an owner's focused disclosure. */
function syncControlChildren(parent: HTMLElement, nodes: readonly Element[]): void {
  const keep = new Set(nodes);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  nodes.forEach((node, index) => {
    const position = parent.children.item(index);
    if (position !== node) parent.insertBefore(node, position);
  });
}

/**
 * The composer's own row of controls.
 *
 * Rebuilt only when what it says changes: while a run is spending, the send
 * control interjects and a second control stops the run — the dashboard's own
 * split, and the same one Enter and Esc follow.
 */
function renderComposerBar(): void {
  const running = chat.runActive;
  const thinking = chat.reasoningLive;
  const hasDraft = Boolean(composer.value.trim());
  const taskDisabled = workbenchBusy() || localWorkbench.candidate?.phase==='stopped'
    || desktop.snapshot?.routeRunnable !== true || !hasDraft;
  const signature = JSON.stringify([running, thinking, forecast, chat.attachments, hasDraft, taskDisabled, workbenchRequestPending,localWorkbench]);
  if (signature === barSignature) return;
  barSignature = signature;
  composerBox.querySelector(".composer-attachments")?.remove();
  composerBox.querySelector('.candidate-panel')?.remove();
  composerBox.prepend(candidatePanel(localWorkbench,workbenchBusy(),action=>void localCandidateAction(action)));
  if (chat.attachments.length > 0) {
    const attachmentList = el("div", {
      class: "composer-attachments", role: "region", "aria-label": "Anhänge für die nächste Nachricht",
    }, [el("span", { class: "attachment-count", text: chat.attachments.length === 1
      ? "1 Anhang" : `${chat.attachments.length} Anhänge` })]);
    for (const file of chat.attachments) {
      attachmentList.append(el("span", {
        class: "attachment-chip", text: file.name,
        title: `${file.mimeType} · ${file.sizeBytes.toLocaleString("de-DE")} Bytes`,
      }));
    }
    composerBox.prepend(attachmentList);
  }
  const parts: HTMLElement[] = [];
  const previousMenu = composerBar.querySelector<HTMLDetailsElement>(".composer-actions");
  const more = previousMenu ?? el("details", { class: "composer-actions" }) as HTMLDetailsElement;
  if (!previousMenu) more.append(el("summary", { text: "Weitere Aktionen" }));
  const menu = more.querySelector<HTMLElement>(".composer-action-menu")
    ?? el("div", { class: "composer-action-menu", "aria-label": "Zusätzliche Aufgabenaktionen" });
  if (!menu.querySelector(".palette-action")) {
    const palette = el("button", { class: "iconbtn palette-action", type: "button", text: "Befehle", "aria-label": "Befehle", title: "Alle Befehle durchsuchen (⌘P)" });
    palette.addEventListener("click", () => { more.open = false; void openPalette(); });
    menu.append(palette);
  }
  if (!menu.isConnected) more.append(menu);
  parts.push(more);
  // Only where the terminal shows it: on the composer, with a draft, and
  // never while a run is already spending. `null` is silence, not zero.
  if (!running && forecast) parts.push(el("span", { class: "forecast", text: forecast }));
  parts.push(el("span", { class: "spacer" }));
  if (running) {
    const stop = el("button", {
      class: "iconbtn danger",
      type: "button",
      text: thinking ? "Denken beenden" : "Abbrechen",
    });
    stop.addEventListener("click", () => void escape());
    parts.push(stop);
  }
  const send = el("button", {
    class: "send",
    type: "button",
    text: running ? "Ergänzen" : "Aufgabe starten",
    disabled: running?!hasDraft:taskDisabled,
  });
  send.addEventListener("click", () => void submit());
  parts.push(send);
  syncControlChildren(composerBar, parts);
}

function renderSlashCompletion(): void {
  composerSlot.querySelector(".slash-complete")?.remove();
  const completion = slashCompletion;
  if (!completion?.rows.length) return;
  composerSlot.prepend(slashCompletionPanel(completion, {
    choose: (row) => activateCompletionRow(completion, row),
  }));
}

function activateCompletionRow(completion: SlashCompletionState, row: GuiPaletteRow): void {
  if (
    slashCompletion !== completion
    || completion.raw !== composer.value
    || !completion.rows.includes(row)
    || !row.command
    || row.presentation.disabled
  ) return;
  slashCompletion = null;
  if (row.verb === "insert") insertCompletion(row);
  else {
    composer.value = row.command;
    void submit();
  }
}

function insertCompletion(row: GuiPaletteRow): void {
  if (!row.command || row.presentation.disabled) return;
  composer.value = `${row.command} `;
  invalidateForecast();
  slashCompletion = null;
  autosize();
  schedule();
  queueMicrotask(() => composer.focus());
}

async function refreshSlashCompletion(): Promise<void> {
  const context = captureMountContext();
  if (!context) return;
  const requestGeneration = ++slashCompletionRequestGeneration;
  const raw = composer.value;
  slashCompletion = null;
  schedule();
  if (!raw.startsWith("/") || raw.includes(" ")) {
    return;
  }
  try {
    const level = await context.bridge.request<PaletteLevel>("catalog.search", { query: normalizeCatalogQuery(raw) });
    if (
      !isCurrentMountContext(context)
      || requestGeneration !== slashCompletionRequestGeneration
      || composer.value !== raw
    ) return;
    slashCompletion = { raw, rows: level.rows, selected: 0 };
    schedule();
  } catch {
    if (
      !isCurrentMountContext(context)
      || requestGeneration !== slashCompletionRequestGeneration
      || composer.value !== raw
    ) return;
    slashCompletion = null;
    schedule();
  }
}

/* --- the palette --------------------------------------------------------- */

let palette: PaletteState | null = null;

/**
 * ⌘P (Ctrl+P is the palette's key in the terminal too), and typing filters.
 *
 * The palette holds no catalog of its own: every open and every keystroke
 * asks the engine, which answers from `resolveCommandMenuRows`.
 */
async function openPalette(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  if (engine.phase !== "ready") return;
  palette = emptyPalette();
  await loadPalette(context);
}

async function loadPalette(
  context: MountAsyncContext | null = captureMountContext(),
): Promise<void> {
  if (!context) return;
  const state = palette;
  if (!state) return;
  const requestGeneration = ++paletteRequestGeneration;
  state.rows = [];
  state.total = 0;
  state.selected = 0;
  redrawPalette();
  try {
    const level = state.query.trim()
      ? await context.bridge.request<PaletteLevel>("catalog.search", { query: state.query })
      : await context.bridge.request<PaletteLevel>("catalog.level", { path: state.path });
    if (
      !isCurrentMountContext(context)
      || palette !== state
      || requestGeneration !== paletteRequestGeneration
    ) return;
    state.crumb = level.crumb ?? ["Commands"];
    state.rows = level.rows ?? [];
    state.total = typeof level.total === "number" ? level.total : state.rows.length;
    state.selected = 0;
    redrawPalette();
  } catch (error) {
    if (
      !isCurrentMountContext(context)
      || palette !== state
      || requestGeneration !== paletteRequestGeneration
    ) return;
    closePalette();
    reportEngineError(error);
  }
  schedule();
}

function closePalette(): void {
  paletteRequestGeneration += 1;
  palette = null;
  palettePanelHandle = null;
  schedule();
}

/**
 * What Enter does — the engine's verb, performed literally.
 *
 * `run` dispatches the command, `insert` fills the composer and leaves the
 * argument to the owner, `open` walks one level (or, on the no-match row,
 * clears the failed query). Nothing here re-decides which is which.
 */
function activatePaletteRow(row: PaletteRow): void {
  const state = palette;
  if (!state) return;
  if (row.presentation.disabled) return;
  if (row.verb === "open") {
    if (row.kind === "recovery") {
      state.query = "";
      state.path = [];
    } else {
      state.path = [...state.path, row.name];
      state.query = "";
    }
    void loadPalette();
    return;
  }
  const command = row.command;
  if (!command) return;
  if (row.verb === "insert") {
    // The composer's existing text is captured before it is replaced — the
    // dashboard does the same, and it is what `/cross`'s gate runs against.
    pendingCommandDraft = composer.value.trim();
    // The composer gets the token and a trailing space, exactly as Tab's
    // completion does.
    composer.value = `${command} `;
    invalidateForecast();
    closePalette();
    // It fills a composer that only exists on the chat surface, so it needs
    // that surface the same way a dispatched command does — asked for, never
    // assumed (review M1).
    surface.run(() => {
      schedule();
      queueMicrotask(() => composer.focus());
    });
    return;
  }
  pendingCommandDraft = composer.value.trim();
  closePalette();
  dispatchCommand(command);
}

/* --- the stream ---------------------------------------------------------- */

const streamHandlers = {
  toggle: toggleBlock,
  // The run footer's own control. `/undo` runs through the same command path
  // a typed one does, so its D4 confirmation — and its refusal when there is
  // nothing to undo — are the engine's own, word for word.
  undo: () => dispatchCommand("/undo"),
};

let emptyAppearanceSignature: boolean | null = null;

function renderStream(): void {
  // Capture intent BEFORE any message changes the scroll height. Checking
  // after insertion mistakes a large arriving block for owner scroll-away.
  const followBottom = contentSlot.scrollHeight - contentSlot.scrollTop - contentSlot.clientHeight < 120;
  const seen = new Set<string>();
  let previous: HTMLElement | null = null;
  for (const block of chat.blocks) {
    seen.add(block.id);
    const existing = streamNodes.get(block.id);
    if (existing?.node instanceof HTMLDetailsElement && (block.kind === "reasoning" || block.kind === "tool")) {
      // The DOM already knows a user's toggle even before its queued native
      // event fires. Never replace that intent with an older model snapshot.
      block.collapsed = !existing.node.open;
    }
    const signature = blockSignature(block);
    let node: HTMLElement;
    if (existing && existing.signature === signature) {
      node = existing.node;
    } else {
      const rendered = renderBlock(block, streamHandlers);
      const summary = existing?.node instanceof HTMLDetailsElement
        ? existing.node.querySelector("summary") : null;
      const nextSummary = rendered instanceof HTMLDetailsElement ? rendered.querySelector("summary") : null;
      if (existing && summary && nextSummary) {
        // Keep the native disclosure and its focused summary mounted. Only
        // the presentation inside them changes while a stream is arriving.
        node = existing.node;
        summary.replaceChildren(...nextSummary.childNodes);
        for (const child of [...node.children]) if (child !== summary) child.remove();
        for (const child of [...rendered.children]) if (child !== nextSummary) node.append(child);
      } else if (existing && block.kind === "assistant") {
        node = existing.node;
        updateMessageMarkdown(node.querySelector<HTMLElement>(".message-markdown")!, rendered.querySelector<HTMLElement>(".message-markdown")!);
        node.querySelector(".cursor")?.remove();
        const cursor = rendered.querySelector(".cursor");
        if (cursor) node.append(cursor);
      } else {
        node = rendered;
        if (existing) existing.node.replaceWith(node);
      }
      streamNodes.set(block.id, { node, signature });
    }
    if (!node.isConnected) {
      if (previous) previous.after(node);
      else streamRoot.prepend(node);
    }
    previous = node;
  }
  for (const [id, entry] of [...streamNodes]) {
    if (!seen.has(id)) {
      entry.node.remove();
      streamNodes.delete(id);
    }
  }
  // An empty chat says so rather than showing a blank pane that could be
  // mistaken for a transcript that failed to load.
  if (chat.blocks.length === 0) {
    const showLargeLogo = desktop.snapshot?.appearance.showLargeLogo === true
      && desktop.snapshot?.appearance.showHeaderMark !== true;
    if (emptyAppearanceSignature !== showLargeLogo) {
      emptyAppearanceSignature = showLargeLogo;
      replace(emptyStream, [
        showLargeLogo ? routeCoreBrand("empty") : null,
        el("h1", { class: "empty-start-title", text: "Was möchtest du bauen?" }),
        el("p", { class: "empty-start-help", text: "Wähle dein Modell und beschreibe die Aufgabe. Änderungen und Ausgaben findest du anschließend unter Änderungen." }),
      ]);
    }
    if (!emptyStream.isConnected) streamRoot.append(emptyStream);
  } else {
    emptyStream.remove();
  }
  if (followBottom) contentSlot.scrollTop = contentSlot.scrollHeight;
}

/**
 * Rebuilt only when the panel's own facts change: it sits under a scroll the
 * owner may be reading, and a per-frame rebuild during a Cross run would
 * fight them for it.
 */
let crossSignature: string | null = null;
let crossSnapshotRevision = 0;
function renderCrossPanel(): void {
  const signature = chat.cross
    ? `${crossSnapshotRevision}:${JSON.stringify(chat.cross)}`
    : null;
  if (signature === crossSignature) return;
  crossSignature = signature;
  replace(crossSlot, chat.cross
    ? [crossPanel(chat.cross, createCrossActionHandlers(dispatchCommand))]
    : []);
}

function toggleBlock(id: string, collapsed: boolean): void {
  const block = chat.blocks.find((entry: Block) => entry.id === id);
  if (!block) return;
  if (block.kind === "reasoning" || block.kind === "tool") {
    block.collapsed = collapsed;
    // Keep the node's signature in step so the next render does not undo it.
    const entry = streamNodes.get(id);
    if (entry) entry.signature = blockSignature(block);
  }
}

/**
 * The overlay is rebuilt only when WHICH overlay changed.
 *
 * Not an optimization: a dialog rebuilt on every frame would clear the field
 * a person is typing into — a folder path, a secret — because a `status`
 * event arrived while they were typing it.
 */
let overlayKey: string | null = null;

function onboardingOverlayKey(view: DesktopOnboardingView): string {
  const value = JSON.stringify(view);
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `onboarding:${view.revision}:${view.generation}:${view.step}:${value.length}:${(hash >>> 0).toString(36)}`;
}

function dismissOnboarding(view: DesktopOnboardingView): void {
  dispatchOnboarding({
    kind: "cancel",
    revision: view.revision,
    generation: view.generation,
    ...(view.operationHandle ? { operationHandle: view.operationHandle } : {}),
  });
}

function renderOverlay(): void {
  const ask = asks.current;
  const activeOnboarding = onboardingVisible && !onboardingAwaitingView
    ? desktop.onboarding
    : null;
  // A question outranks everything: it is the one dialog with a consequence
  // behind it. A deliberately opened onboarding flow then owns the route
  // decision until it settles; its passive boot-time view is never enough to
  // open a dialog by itself.
  const key = ask
    ? `ask:${ask.askId}`
    : activeOnboarding
      ? onboardingOverlayKey(activeOnboarding)
      : palette
        ? "palette"
        : engine.phase === "stopped" || engine.phase === "failed"
          ? `engine:${engine.phase}:${engine.failure?.code ?? ""}:${engine.exit?.code ?? ""}:${engine.exit?.signal ?? ""}:${info?.pid ?? ""}`
          : null;
  if (key === overlayKey && overlayHandle?.element.isConnected !== false) return;
  const closingOnboarding = key === null && overlayKey?.startsWith("onboarding:");
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlayHandle?.close();
  overlayHandle = null;
  overlayKey = key;
  if (key === null) {
    if (closingOnboarding && document.activeElement === document.body) {
      (root.querySelector<HTMLElement>(".route-change") ?? composer)?.focus();
    }
    onboardingTrigger = null;
    return;
  }
  if (!overlayManager) throw new Error("The desktop overlay manager is not mounted.");

  const labelId = `desktop-overlay-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}-title`;
  if (ask) {
    const isCrossPreflight = ask.kind === "choice"
      && ask.payload.presentation === "cross-preflight";
    overlayHandle = overlayManager.open({
      id: key,
      trigger,
      labelId,
      initialFocus: "safe-action",
      onDismiss: () => answerAsk(ask, declineAnswer(ask)),
      render: () => isCrossPreflight && crossPreflight
        ? crossPreflightPanel(crossPreflight, ask, {
            answer: answerAsk,
            decline: (pending) => answerAsk(pending, declineAnswer(pending)),
          })
        : askPanel(ask, {
            answer: answerAsk,
            decline: (pending) => answerAsk(pending, declineAnswer(pending)),
          }),
    });
    return;
  }
  if (activeOnboarding) {
    overlayHandle = overlayManager.open({
      id: key,
      trigger: onboardingTrigger ?? trigger,
      labelId,
      initialFocus: "safe-action",
      onDismiss: () => dismissOnboarding(activeOnboarding),
      render: () => onboardingView(activeOnboarding, { dispatch: dispatchOnboarding,
        manufacturer:{states:manufacturerStates,nativeAvailable:manufacturerNativeAvailable,
          busy:manufacturerBusy,action:(provider,action)=>void manufacturerAction(provider,action)}}),
    });
    return;
  }
  const paletteState = palette;
  if (paletteState) {
    overlayHandle = overlayManager.open({
      id: key,
      trigger,
      labelId,
      initialFocus: "safe-action",
      onDismiss: closePalette,
      render: () => mountPalette(paletteState),
    });
    return;
  }

  const restart = (): void => { void boot({ restart: true }); };
  overlayHandle = overlayManager.open({
    id: key,
    trigger,
    labelId,
    initialFocus: "safe-action",
    onDismiss: restart,
    render: () => enginePanel(engine, engineFacts(), runWasActive, restart),
  });
}

/**
 * The palette is mounted once and redrawn in place; only its OPENNESS is an
 * overlay change. Rebuilding it per keystroke would clear the field being
 * typed into, which is the same defect the ask dialogs were fixed for.
 */
let palettePanelHandle: PalettePanel | null = null;
function mountPalette(state: PaletteState): HTMLElement {
  palettePanelHandle = palettePanel(state, {
    activate: activatePaletteRow,
    filter: (query) => {
      if (!palette) return;
      palette.query = query;
      void loadPalette();
    },
    move: (delta) => {
      if (!palette) return;
      movePalette(palette, delta);
      redrawPalette();
    },
    up: () => {
      if (!palette || palette.path.length === 0) return;
      palette.path = palette.path.slice(0, -1);
      void loadPalette();
    },
  });
  return palettePanelHandle.node;
}

function redrawPalette(): void {
  if (palette && palettePanelHandle) palettePanelHandle.update();
}

function engineFacts(): readonly string[] {
  if (!info) return [];
  return [
    `node: ${info.node}`,
    `engine: ${info.script}`,
    `folder: ${info.workspace}`,
    info.realHome
      ? `home: ${info.home} (your real orcode home)`
      : `home: ${info.home} (a development fixture — your real ~/.orcode is untouched)`,
  ];
}

/* --- input -------------------------------------------------------------- */

function autosize(): void {
  composer.style.height = "auto";
  composer.style.height = `${Math.min(composer.scrollHeight, 200)}px`;
}

async function escape(): Promise<void> {
  // The dashboard's own split: while the model is thinking, Esc ends the
  // thinking; otherwise it cancels the run.
  if (chat.reasoningLive) await endThinking();
  else await cancelRun();
}

/**
 * The pre-submit band the terminal's status line shows.
 *
 * Asked, never computed: the engine owns the route's price, the chat's
 * context size and the output-token band, and it answers with the exact text
 * `formatPromptCostForecast` produces. Debounced because a keystroke is not
 * a new fact — the figure only changes with the draft's length.
 */
let forecastTimer: number | null = null;
function invalidateForecast(): void {
  forecast = null;
  forecastRequestGeneration += 1;
  if (forecastTimer !== null) {
    window.clearTimeout(forecastTimer);
    forecastTimer = null;
  }
}

function scheduleForecast(): void {
  if (forecastTimer !== null) window.clearTimeout(forecastTimer);
  forecastTimer = window.setTimeout(() => {
    forecastTimer = null;
    void refreshForecast();
  }, 200);
}

async function refreshForecast(): Promise<void> {
  const context = captureMountContext();
  if (!context) return;
  if (engine.phase !== "ready") return;
  const requestGeneration = ++forecastRequestGeneration;
  const draftChars = composer.value.trim().length;
  if (draftChars === 0) { forecast = null; schedule(); return; }
  try {
    const answer = await context.bridge.request<CostForecast>("cost.forecast", { draftChars });
    if (!isCurrentMountContext(context) || requestGeneration !== forecastRequestGeneration) return;
    // `none` is silence, not zero — an unpriced route shows no segment at
    // all rather than a guess.
    forecast = answer.kind === "none" ? null : answer.text ?? null;
  } catch {
    if (!isCurrentMountContext(context) || requestGeneration !== forecastRequestGeneration) return;
    // A forecast is display-only chrome; a failed read shows nothing rather
    // than a stale number, and never raises an error at the owner.
    forecast = null;
  }
  schedule();
}

function installInputHandlers(): void {
  composer.addEventListener("input", markComposerEdited);
  composer.addEventListener("input", autosize);
  composer.addEventListener("input", scheduleForecast);
  composer.addEventListener("input", refreshSlashCompletion);
  composer.addEventListener("keydown", handleComposerKeydown);
  document.addEventListener("keydown", handleDocumentKeydown);
}

function uninstallInputHandlers(): void {
  composer.removeEventListener("input", markComposerEdited);
  composer.removeEventListener("input", autosize);
  composer.removeEventListener("input", scheduleForecast);
  composer.removeEventListener("input", refreshSlashCompletion);
  composer.removeEventListener("keydown", handleComposerKeydown);
  document.removeEventListener("keydown", handleDocumentKeydown);
}

function markComposerEdited(): void {
  composerEditGeneration += 1;
  invalidateForecast();
  schedule();
}

function handleComposerKeydown(event: KeyboardEvent): void {
  const currentCompletion = slashCompletion?.raw === composer.value ? slashCompletion : null;
  if (currentCompletion && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    const count = currentCompletion.rows.length;
    if (count) slashCompletion = { ...currentCompletion, selected: (currentCompletion.selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count };
    schedule();
    return;
  }
  if (currentCompletion && event.key === "Tab") {
    event.preventDefault();
    const row = currentCompletion.rows[currentCompletion.selected];
    if (row) insertCompletion(row);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (composer.value.startsWith("/") && !composer.value.includes(" ")) {
      if (!currentCompletion) return;
      const exact = currentCompletion.rows.filter((row) =>
        row.command === `/${normalizeCatalogQuery(composer.value)}`);
      // A fully typed command always wins over the list's default selection.
      // For a prefix, Enter means what the highlighted row says—exactly like
      // mouse activation and Tab—while disabled rows remain inert.
      const row = exact.length === 1 ? exact[0] : currentCompletion.rows[currentCompletion.selected];
      if (!row || row.presentation.disabled) return;
      activateCompletionRow(currentCompletion, row);
      return;
    }
    void submit();
  }
}

function typingSomewhere(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (asks.current) return;
  if (event.key === "Tab" && navigationOpen && window.innerWidth < 900 && !palette && !onboardingVisible) {
    const buttons = [...sideNode.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const first = buttons[0];
    const last = buttons.at(-1);
    if (first && last && (event.shiftKey
      ? document.activeElement === first || !sideNode.contains(document.activeElement)
      : document.activeElement === last || !sideNode.contains(document.activeElement))) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
    return;
  }
  if (event.key === "Escape" && !palette && !onboardingVisible) {
    if (navigationOpen && window.innerWidth < 900) {
      event.preventDefault();
      setNavigationOpen(false, true);
      return;
    }
    const more = composerBar.querySelector<HTMLDetailsElement>(".composer-actions");
    if (more?.open) {
      event.preventDefault();
      more.open = false;
      more.querySelector("summary")?.focus();
      return;
    }
  }
  // Ctrl+P is the palette's key in the terminal too (`ui/keymap.ts`), and
  // ⌘P is what this platform's hands reach for. It is never bound while a
  // question is open: a consent point owns the keyboard until it is answered.
  if ((event.ctrlKey || event.metaKey) && (event.key === "p" || event.key === "P")) {
    event.preventDefault();
    if (palette) closePalette();
    else void openPalette();
    return;
  }
  if (palette) {
    // The card's own field owns every other key while it is open.
    return;
  }
  if (surface.settingsOpen && settings) {
    // Search text stays a native field. Escape still walks the deepest
    // canonical Settings level first; Fertig remains the dedicated close.
    if (typingSomewhere(event.target)) {
      if (event.key === "Escape") {
        event.preventDefault();
        backSettings();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      backSettings();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = [...contentSlot.querySelectorAll<HTMLButtonElement>(".settings-row:not(:disabled)")];
      if (rows.length === 0) return;
      const current = document.activeElement instanceof HTMLButtonElement
        ? rows.indexOf(document.activeElement)
        : -1;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      rows[(current + delta + rows.length) % rows.length]?.focus();
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      const rows = [...contentSlot.querySelectorAll<HTMLButtonElement>(".settings-row:not(:disabled)")];
      rows[event.key === "PageDown" ? rows.length - 1 : 0]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const rows = [...contentSlot.querySelectorAll<HTMLButtonElement>(".settings-row:not(:disabled)")];
      rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // F6 ruling 1, on this surface: ←/→ walk the tab bar through the SAME
      // `category` intent the tabs and the digits use — one jump, one
      // `#selectCategory`, clamped at both ends rather than wrapping, and
      // never while the search owns the keyboard.
      const categories = settings?.categories ?? [];
      if (settings?.search.active || categories.length === 0) return;
      event.preventDefault();
      const current = categories.findIndex((entry) => entry.id === settings?.selectedCategoryId);
      const next = categories[Math.min(
        categories.length - 1,
        Math.max(0, Math.max(0, current) + (event.key === "ArrowLeft" ? -1 : 1)),
      )];
      if (next) dispatchSettings({
        kind: "select-category",
        categoryId: next.id,
        revision: settings.revision,
      }, { kind: "category", id: next.id });
    } else if (event.key === "/") {
      event.preventDefault();
      contentSlot.querySelector<HTMLInputElement>(".settings-search")?.focus();
    } else if (/^[1-9]$/.test(event.key)) {
      // The ordinal that selects a tab, exactly as the tab bar's own title
      // names it.
      const index = Number(event.key) - 1;
      const category = settings?.categories[index];
      if (!category || settings?.search.active) return;
      event.preventDefault();
      dispatchSettings({
        kind: "select-category",
        categoryId: category.id,
        revision: settings.revision,
      }, { kind: "category", id: category.id });
    } else if (event.key === "Enter") {
      const target = document.activeElement;
      if (target instanceof HTMLButtonElement && target.classList.contains("settings-row")) {
        event.preventDefault();
        target.click();
      }
    }
    return;
  }
  if (event.key === "Escape" && inspectorOpen && workbenchPanel.node.contains(document.activeElement) && !chat.runActive) {
    event.preventDefault();
    setInspectorOpen(false, true);
    return;
  }
  if (event.key === "Escape" && chat.runActive) {
    // While something is running Esc stops it — the dashboard's own split.
    // With nothing running there is nowhere to go back TO any more: the
    // sidebar never left, so Esc is deliberately not bound to anything.
    event.preventDefault();
    void escape();
  }
}

const productionRoot = document.querySelector<HTMLElement>("#app");
if (productionRoot) {
  mountDesktopWindow({ bridge: createProductionBridge(), root: productionRoot });
}
