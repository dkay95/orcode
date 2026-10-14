#!/usr/bin/env node

/**
 * The child process one GUI-protocol pin talks to.
 *
 * Same discipline as `journey-pty-harness.mjs`: a real workspace and app-home
 * on a temp dir, a real `SessionStore`/`RuleStore`/`OpenRouterService`, and a
 * STUBBED `ProviderRuntime` + agent so no network call, no keychain read and
 * no route mutation ever happens. It imports the REAL built
 * `dist/gui-server.js` and hands it the same `CliBootstrapDeps` shape
 * `runCli` already takes, so the protocol is exercised against the shipped
 * module rather than a re-implementation.
 *
 * No PTY: the protocol is a plain pipe, which is the entire point of D1.
 * `process.argv[2]` selects a scenario; the differences are only in what the
 * stubbed agent does.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const guiModuleUrl = process.env.ORCODE_GUI_SERVER_MODULE;
if (!guiModuleUrl) throw new Error("ORCODE_GUI_SERVER_MODULE is missing.");
const scenario = process.argv[2] ?? "default";
const desktopNanoScenario = scenario.startsWith("desktop-empty-nanogpt");
const desktopSettingsProviderGuidanceScenario = scenario === "desktop-empty-settings-provider-guidance";
const desktopSettingsConnectedProviderGuidanceScenario = scenario === "desktop-connected-settings-provider-guidance";
const desktopKimiProofScenario = desktopSettingsProviderGuidanceScenario
  || scenario === "desktop-empty-kimi-proof"
  || scenario === "route-picker-kimi-trap";
const settingsTimeoutReleaseScenario = scenario === "settings-timeout-release"
  || scenario === "settings-timeout-release-error";
const startupInspectionHeldScenario = scenario === "desktop-empty-startup-held";
let releaseStartupInspection = () => {};
let startupInspectionStarted = 0;
let startupInspectionReleased = 0;
const startupInspectionBarrier = new Promise((resolve) => {
  releaseStartupInspection = resolve;
});
if (startupInspectionHeldScenario) {
  process.on("SIGUSR1", () => releaseStartupInspection());
}
let releaseSettingsTimeoutMutation = () => {};
let resolveSettingsTimeoutAdvance = () => {};
const settingsTimeoutAdvanceSettled = new Promise((resolve) => {
  resolveSettingsTimeoutAdvance = resolve;
});
let settingsTimeoutReleaseFrames = 0;
let settingsTimeoutCloseAccepted = 0;
let settingsTimeoutTransportDeferrals = 0;
let settingsTimeoutMutationReleased = 0;
let settingsTimeoutControllerSettlements = 0;
let protocolAskFrames = 0;
let protocolActivityFrames = 0;
let protocolTranscriptFrames = 0;
let protocolSettingsClosedFrames = 0;
let captureKimiBaseline = () => {};
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk, ...args) => {
  for (const line of String(chunk).split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const frame = JSON.parse(line);
      if (frame.t === "ask") protocolAskFrames += 1;
      if (frame.t === "event" && frame.e === "activity") protocolActivityFrames += 1;
      if (frame.t === "event" && frame.e === "transcript") protocolTranscriptFrames += 1;
      if (frame.t === "event" && frame.e === "settings.closed") protocolSettingsClosedFrames += 1;
      if (settingsTimeoutReleaseScenario && frame.t === "event" && frame.e === "settings.closed") {
        settingsTimeoutReleaseFrames += 1;
        releaseSettingsTimeoutMutation();
      }
      if (frame.t === "response" && frame.ok === true && frame.result?.snapshot?.providers) {
        captureKimiBaseline();
      }
    } catch {}
  }
  return originalStdoutWrite(chunk, ...args);
});
// The `claimed-owner` scenario: the launcher STATES a mode it cannot prove.
// The engine must derive its own anyway — that is the trust rule.
if (scenario === "claimed-owner") {
  process.env.ORCODE_GUI_SHELL = "tauri";
  process.env.ORCODE_GUI_EXECUTION_MODE = "local-interactive-owner";
}

const gui = await import(guiModuleUrl);
const { GuiTransport } = gui;
const agentModule = await import(new URL("./agent.js", guiModuleUrl));
const { AgentRunError, OrcodeAgent, bindModelRuntimeIdentity } = agentModule;
const config = await import(new URL("./config.js", guiModuleUrl));
const { SessionStore } = await import(new URL("./session.js", guiModuleUrl));
const { RuleStore } = await import(new URL("./rules.js", guiModuleUrl));
const { OpenRouterService } = await import(new URL("./openrouter.js", guiModuleUrl));
const { CHAT_ARTIFACT_REGISTRY } = await import(new URL("./storage.js", guiModuleUrl));
const { BackendRegistry } = await import(new URL("./backends.js", guiModuleUrl));
const { KIMI_CODE_DESCRIPTOR } = await import(new URL("./kimi-code-backend.js", guiModuleUrl));
const { KIMI_CODE_MODELS } = await import(new URL("./kimi-code.js", guiModuleUrl));
const { ProviderStateStore, createNeverConfiguredProviderState } = await import(
  new URL("./provider-state.js", guiModuleUrl)
);
const { SetupOrchestrator } = await import(new URL("./setup.js", guiModuleUrl));
const { runSetupHub } = await import(new URL("./setup-surface/index.js", guiModuleUrl));
const cliModule = await import(new URL("./cli.js", guiModuleUrl));
const { DefaultProviderRuntime, SessionProviderRuntimeGuard, persistProviderSetupState } = cliModule;
const { ProviderActivationCoordinator } = await import(new URL("./provider-activation.js", guiModuleUrl));
const { ProviderCredentialAuthority } = await import(new URL("./provider-authority.js", guiModuleUrl));
const { PrivateStore } = await import(new URL("./private-store.js", guiModuleUrl));
const { createRoutePickerAuthority } = await import(new URL("./route-picker.js", guiModuleUrl));
const { SettingsController } = await import(new URL("./settings-controller.js", guiModuleUrl));

if (settingsTimeoutReleaseScenario) {
  const realAbandonPendingAsks = GuiTransport.prototype.abandonPendingAsks;
  GuiTransport.prototype.abandonPendingAsks = function controlledSettingsClose(owner) {
    if (owner !== undefined && settingsTimeoutCloseAccepted === 0) {
      settingsTimeoutCloseAccepted += 1;
      process.stderr.write("ORCODE_GUI_GATE:settings-close-accepted\n");
    }
    return realAbandonPendingAsks.call(this, owner);
  };
  const realAfterResponse = GuiTransport.prototype.afterResponse;
  GuiTransport.prototype.afterResponse = function controlledTerminalClose(run) {
    settingsTimeoutTransportDeferrals += 1;
    return realAfterResponse.call(this, () => {
      void settingsTimeoutAdvanceSettled.then(() => setImmediate(run));
    });
  };
}

let settingsDesktopBeginCalls = 0;
let settingsDesktopAdvanceCalls = 0;
let settingsDesktopCancelAdvances = 0;
let settingsDesktopAbortCalls = 0;
const realBeginDesktopOperation = SettingsController.prototype.beginDesktopOperation;
SettingsController.prototype.beginDesktopOperation = function countedDesktopBegin(...args) {
  settingsDesktopBeginCalls += 1;
  return realBeginDesktopOperation.apply(this, args);
};
const realAdvanceDesktopOperation = SettingsController.prototype.advanceDesktopOperation;
SettingsController.prototype.advanceDesktopOperation = function countedDesktopAdvance(...args) {
  settingsDesktopAdvanceCalls += 1;
  if (args[2]?.kind === "cancel") settingsDesktopCancelAdvances += 1;
  const result = realAdvanceDesktopOperation.apply(this, args);
  if (!settingsTimeoutReleaseScenario) return result;
  return Promise.resolve(result)
    .then((settled) => {
      if (scenario === "settings-timeout-release-error") {
        throw new Error("fixture post-settlement Settings failure");
      }
      return settled;
    })
    .finally(() => {
      settingsTimeoutControllerSettlements += 1;
      resolveSettingsTimeoutAdvance();
    });
};
const realAbortDesktopOperation = SettingsController.prototype.abortDesktopOperation;
SettingsController.prototype.abortDesktopOperation = function countedDesktopAbort(...args) {
  settingsDesktopAbortCalls += 1;
  return realAbortDesktopOperation.apply(this, args);
};

// Counted on the real class, so "saved exactly once" is measured rather
// than asserted from internal state.
let saveCalls = 0;
const realSave = SessionStore.prototype.save;
SessionStore.prototype.save = function countedSave(...args) {
  saveCalls += 1;
  return realSave.apply(this, args);
};

const root = await mkdtemp(join(tmpdir(), "orcode-gui-"));
const workspace = join(root, "workspace");
let localAgentWorkspace=workspace;
const appHome = join(root, "app");
const configPath = join(appHome, "config.json");
// A SECOND real folder on disk, so opening its chat exercises the real
// `reRootWorkspace` rather than a stub that always says yes.
const foreignWorkspace = join(root, "elsewhere");
await mkdir(workspace, { recursive: true });
await mkdir(foreignWorkspace, { recursive: true });
await mkdir(appHome, { recursive: true });
await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { check: "tsc" } }));

const MODEL_ID = "vendor/gui-main";
// A second catalog row, so the `/model` picker has an actual choice to offer.
const ALT_MODEL_ID = "vendor/gui-alternate";
const modelTransitions = [];
const persisted = structuredClone(config.DEFAULT_CONFIG);
if(scenario==='local-workcopy')persisted.verify.commands=[`${JSON.stringify(process.execPath)} -e ${JSON.stringify("if(require('fs').readFileSync('notes.md','utf8')!=='local candidate\\n')process.exit(1)")}`];
persisted.mainModel = MODEL_ID;
persisted.maxSteps = 7;
// The fixture catalog holds exactly one model, so nothing else may be
// resolved against it: a fallback or compressor id that is not in the
// catalog would fail the run for a reason the pin is not about.
persisted.fallbackModels = [];
persisted.compressionMode = "off";
await config.saveConfig(persisted, configPath);

/**
 * A route bearing the canary strings the redaction pin hunts for. Nothing in
 * this fixture is allowed to reach the wire carrying either of them.
 */
const route = Object.freeze({
  version: 1,
  backendId: "openrouter",
  accountFingerprint: "acct_or_SECRETCANARYFINGERPRINT0000000000000",
  billingRealm: "openrouter-payg",
  requestedModelId: MODEL_ID,
  canonicalModelId: MODEL_ID,
  resolutionState: "resolved",
});

const desktopCandidate = (handle) => Object.freeze({
  handle,
  providerId: "openrouter",
  connectionId: "desktop-connection",
  accountLabel: "Persönliches OpenRouter",
  canonicalModelId: MODEL_ID,
  displayName: "GUI Main",
  reasoning: "supported",
  capabilities: ["text", "tools"],
  cost: { kind: "known", label: "OpenRouter-Tarif", source: "provider" },
  dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" },
  runnable: true,
});
const desktopProvider = (candidate = null, state = "ready") => Object.freeze({
  providerId: "openrouter",
  providerLabel: "OpenRouter",
  connectionId: candidate ? "desktop-connection" : null,
  accountLabel: candidate ? "Persönliches OpenRouter" : null,
  state,
  setupMethods: ["openrouter-owner-connect"],
  multiProfile: { enabled: false },
  routes: candidate ? [candidate] : [],
});
const desktopNanoProvider = (ready = false, mode = "subscription") => ({
  providerId: "nano-gpt", providerLabel: "Nano-GPT", connectionId: ready ? "desktop-nano-connection" : null,
  accountLabel: ready ? `Nano-GPT ${mode}` : null, state: ready ? "ready" : "disconnected",
  setupMethods: ["nanogpt-owner-connect"], multiProfile: { enabled: false },
  routes: ready ? [{ handle: "nano-route-ready", providerId: "nano-gpt", connectionId: "desktop-nano-connection", accountLabel: `Nano-GPT ${mode}`, canonicalModelId: "vendor/nano-manual", displayName: "Nano manual", reasoning: "unknown", capabilities: ["text", "tools"], cost: { kind: "unknown", label: "Kosten unbekannt" }, dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" }, runnable: true }] : [],
});
const disabledKimiProvider = Object.freeze({
  providerId: "kimi-code",
  connectionId: null,
  accountLabel: null,
  state: "disabled",
  setupMethods: ["kimi-owner-connect"],
  multiProfile: { enabled: false },
  routes: [],
  disabled: {
    code: "native-local-action-unavailable",
    label: "Kimi Code kann nur im lokalen Eigentümer-Terminal eingerichtet werden.",
    recoveryLabel: "Im lokalen Terminal öffnen",
  },
});
const disabledCodexProvider = Object.freeze({
  providerId: "codex",
  providerLabel: "ChatGPT / Codex",
  connectionId: null,
  accountLabel: null,
  state: "disabled",
  setupMethods: ["codex-browser-login", "codex-device-login"],
  multiProfile: {
    enabled: false,
    disabled: {
      code: "codex-profile-isolation-unproven",
      label: "Profiltrennung ist nicht bestätigt.",
      recoveryLabel: "Anmeldung erneut prüfen",
    },
  },
  routes: [],
  disabled: {
    code: "setup-method-unavailable",
    label: "Einrichtung ist hier nicht verfügbar.",
    recoveryLabel: "Lokales Terminal öffnen",
  },
  repair: {
    code: "setup-method-unavailable",
    label: "Einrichtung ist hier nicht verfügbar.",
    recoveryLabel: "Lokales Terminal öffnen",
  },
});
const readyDesktopSnapshot = (revision = 1, generation = 1, handle = "route-current") => ({
  schemaVersion: 1,
  revision,
  generation,
  routeRunnable: true,
  activeRoute: {
    routeHandle: handle,
    providerLabel: "OpenRouter",
    modelLabel: "GUI Main",
    accountLabel: "Persönliches OpenRouter",
  },
  providers: [desktopProvider(desktopCandidate(handle))],
  undoAvailable: false,
  appearance: { showLargeLogo: true, showHeaderMark: true },
});
let desktopSnapshot = scenario === "desktop-connected" || desktopSettingsConnectedProviderGuidanceScenario
  || scenario === "desktop-durable-cancel"
  || scenario === "desktop-activation-fail-once" || scenario === "desktop-activation-fail-once-durable"
  ? {
      ...readyDesktopSnapshot(),
      routeRunnable: false,
      activeRoute: null,
      providers: [desktopProvider(desktopCandidate("route-before"))],
    }
    : scenario === "desktop-old-route-refresh"
      || scenario === "desktop-old-route-refresh-finalize-failure"
      || scenario.startsWith("desktop-old-route-model")
      ? {
          ...readyDesktopSnapshot(1, 1, "route-a"),
          activeRoute: {
            routeHandle: "route-a",
            providerLabel: "OpenRouter",
            modelLabel: "GUI Main",
            accountLabel: "Persönliches OpenRouter",
          },
          providers: [desktopProvider(desktopCandidate("route-b-before"))],
        }
    : scenario === "desktop-empty-stale-cancel"
    ? {
        ...readyDesktopSnapshot(4, 3),
        routeRunnable: false,
        activeRoute: null,
        providers: [desktopProvider(null, "disconnected"), disabledKimiProvider],
      }
    : scenario.startsWith("desktop-empty")
    ? {
        ...readyDesktopSnapshot(),
        routeRunnable: false,
        activeRoute: null,
        providers: [
          desktopProvider(null, "disconnected"),
          ...(desktopNanoScenario ? [desktopNanoProvider()] : []),
          disabledKimiProvider,
          ...(desktopSettingsProviderGuidanceScenario ? [disabledCodexProvider] : []),
        ],
      }
    : readyDesktopSnapshot();
let desktopSetupCalls = 0;
let desktopNanoSetupCalls = 0;
let desktopNanoBillingMode = null;
let desktopNanoSelectedModel = null;
let desktopNanoSecretLength = 0;
let desktopNanoCommitAccepted = 0;
let desktopCodexLoginCalls = 0;
let desktopCodexLoginMethod = null;
if (scenario === "desktop-codex-login" || scenario === "desktop-codex-login-durable-cancel") {
  const { disabled, repair, ...available } = disabledCodexProvider;
  desktopSnapshot = { ...readyDesktopSnapshot(), routeRunnable: false, activeRoute: null,
    providers: [{ ...available, state: "disconnected" }] };
}
let desktopSetupEntered = 0;
let desktopSetupSettled = 0;
let desktopSetupAborted = 0;
let desktopSetupAbortListenersRemoved = 0;
let desktopRefreshCalls = 0;
let desktopActivationCalls = 0;
let desktopCancelCalls = 0;
let desktopCancelCallsBeforeSetupSettlement = null;
let desktopSetupProofReconciliations = 0;
let desktopSetupProofAccepted = 0;
const desktopSetupCommitProofs = new WeakMap();
let releaseForeignDesktopSetup;
let desktopRefreshAborted = 0;
let desktopActiveOperations = 0;
let desktopAbortListenersRemoved = 0;
let desktopActivationReject = null;
let desktopActivationSignal = null;
let desktopFinalizeSnapshotFailureArmed = false;
let desktopCatalogueCalls = 0;
let routePickerCaptureCalls = 0;
let desktopRoutePickerViewCalls = 0;
let desktopRoutePickerResolveCalls = 0;
let desktopAuthorityGetterCalls = 0;
let atomicRaceInitialMatchingRows = 0;
let atomicRaceEpochChanges = 0;
let desktopDisabledKimiBindingProven = false;
let legacyRouteCatalogCalls = 0;
let terminalOwnerAuthorityCalls = 0;
let terminalOwnerViewCalls = 0;
let terminalOwnerResolveCalls = 0;
let crossPreferenceReads = 0;
let crossPreferencePublishes = 0;
let sessionArmCalls = 0;
let modelPreferenceAuthorityReads = 0;
let settingsPublicationPrepares = 0;
let settingsPublicationPublishes = 0;
let transitionEntries = 0;
let adoptSessionCalls = 0;
let configMutationCalls = 0;
let settingsMutationTaskCalls = 0;
let settingsMutationHeld = 0;
let releaseSettingsTimeoutBarrier;
const settingsTimeoutMutationBarrier = new Promise((resolve) => {
  releaseSettingsTimeoutBarrier = resolve;
});
releaseSettingsTimeoutMutation = () => {
  if (settingsTimeoutMutationReleased > 0) return;
  settingsTimeoutMutationReleased += 1;
  releaseSettingsTimeoutBarrier();
};
let genericCredentialCalls = 0;
const credentialMethodCalls = { has: 0, get: 0, set: 0, delete: 0, reserveSlot: 0, readSlot: 0, writeSlot: 0, deleteSlot: 0, hmac: 0 };
let sessionPublicationPrepares = 0;
let sessionPublicationPublishes = 0;
let ownerKimiRunnableBaseline = false;
let desktopKimiCredentialEffects = 0;
let desktopKimiEffectCanary = desktopKimiProofScenario
  ? Object.assign(new Error("KIMI_PRIVATE_CANARY:internal-effect-trap"), {
      privateProviderMaterial: "KIMI_PRIVATE_CANARY",
    })
  : null;
let desktopKimiBaselineLocked = false;
let desktopKimiBaseline = null;
let desktopRerootCalls = 0;
let desktopChatMutationCalls = 0;
captureKimiBaseline = () => {
  if (!desktopKimiProofScenario || desktopKimiBaselineLocked) return;
  desktopKimiBaseline = {
    catalogue: desktopCatalogueCalls, credential: desktopKimiCredentialEffects,
    setup: desktopSetupCalls, refresh: desktopRefreshCalls, activation: desktopActivationCalls,
    transcript: protocolTranscriptFrames, agent: agentCalls,
    cost: freshSession.data.costs.totalUsd, ask: protocolAskFrames, activity: protocolActivityFrames,
  };
  desktopKimiBaselineLocked = true;
};
const enterKimiEffectTrap = (kind) => {
  if (kind === "credential") desktopKimiCredentialEffects += 1;
  if (kind === "catalogue") desktopCatalogueCalls += 1;
  throw desktopKimiEffectCanary ?? new Error(`KIMI_PRIVATE_CANARY:${kind}`);
};
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const desktopDrainTimers = new Set();
let desktopDrainTimersCreated = 0;
let desktopDrainTimersCleared = 0;
globalThis.setTimeout = (callback, delay, ...args) => {
  let timer;
  const wrapped = (...callbackArgs) => {
    desktopDrainTimers.delete(timer);
    return callback(...callbackArgs);
  };
  timer = realSetTimeout(wrapped, delay, ...args);
  if (delay === 5_000) {
    desktopDrainTimers.add(timer);
    desktopDrainTimersCreated += 1;
  }
  return timer;
};
globalThis.clearTimeout = (timer) => {
  if (desktopDrainTimers.delete(timer)) desktopDrainTimersCleared += 1;
  return realClearTimeout(timer);
};

/**
 * The Cross pair for the `cross` scenario: two DIFFERENT canonical models, so
 * `startBlockedReason` is null and Start is actually offerable. Each carries
 * its own fingerprint canary — the gate rows must show model names only.
 */
const crossLeadRoute = Object.freeze({
  ...route,
  accountFingerprint: "acct_or_SECRETCROSSLEADCANARY000000000000",
  requestedModelId: MODEL_ID,
  canonicalModelId: MODEL_ID,
});
const crossChallengerRoute = Object.freeze({
  ...route,
  accountFingerprint: "acct_or_SECRETCROSSCHALLENGERCANARY000000",
  requestedModelId: ALT_MODEL_ID,
  canonicalModelId: ALT_MODEL_ID,
});
const crossKimiLeadRoute = Object.freeze({
  version: 1,
  backendId: "kimi-code",
  accountFingerprint: "KIMI_ARMED_PRIVATE_CANARY",
  billingRealm: "kimi-code-membership-provider-managed-overage",
  requestedModelId: "moonshotai/kimi-k3",
  canonicalModelId: "moonshotai/kimi-k3",
  resolutionState: "resolved",
});
let crossPreferences = scenario === "cross" || scenario === "cross-armed" || scenario === "cross-slow"
  ? { lead: crossLeadRoute, challenger: crossChallengerRoute }
  : { lead: null, challenger: null };

const PRIOR_CHAT_TITLE = "Prior GUI Chat";
const priorChat = SessionStore.create(workspace, appHome, PRIOR_CHAT_TITLE);
priorChat.addTurn("user", "What did we decide?");
priorChat.addTurn("assistant", "To ship the sidecar.");
// Exact legacy setup transcript shape: the typed slash-command turn followed
// by the setup surface's settled outcome line.
priorChat.addTurn("user", "/provider setup");
priorChat.addTurn("assistant", "Provider setup: ready");
priorChat.setPreferences(MODEL_ID, { mode: "auto" }, route);
await priorChat.save();
const priorChatPath = (await CHAT_ARTIFACT_REGISTRY.all("chat", appHome))
  .find((artifact) => artifact.chatId === priorChat.data.id)?.path;
if (!priorChatPath) throw new Error("prior chat fixture path is missing");
const priorChatBytesBefore = await readFile(priorChatPath, "utf8");
const priorChatBefore = JSON.parse(priorChatBytesBefore);
const priorChatTurnCountBefore = priorChatBefore.turns.length;

// The foreign-folder row a hub pick has to be able to open: same app-home,
// a different real workspace, so `chat.open` must re-root to reach it.
const FOREIGN_CHAT_TITLE = "Chat In Another Folder";
const foreignChat = SessionStore.create(foreignWorkspace, appHome, FOREIGN_CHAT_TITLE);
foreignChat.addTurn("user", "Which folder is this?");
foreignChat.addTurn("assistant", "The other one.");
foreignChat.setPreferences(MODEL_ID, { mode: "auto" }, route);
await foreignChat.save();
let releaseReverseMutation;
const reverseMutationHeld = new Promise((resolve) => { releaseReverseMutation = resolve; });
let reverseMutationWaiting = false;

const freshSession = SessionStore.create(workspace, appHome);
// The `cross-armed` scenario: a chat that is already armed, so a plain
// `submit` takes the armed-dispatch branch — the paid two-model path.
if (scenario === "cross-armed" || scenario === "cross-slow" || scenario === "desktop-proof-fails-armed"
  || scenario === "cross-kimi-missing-claim") {
  freshSession.armCrossMode({
    lead: scenario === "cross-kimi-missing-claim" ? crossKimiLeadRoute : crossLeadRoute,
    challenger: crossChallengerRoute,
  });
}
const originalArmCrossMode = freshSession.armCrossMode.bind(freshSession);
freshSession.armCrossMode = (...args) => { sessionArmCalls += 1; return originalArmCrossMode(...args); };
const originalPreparePreferencePublication = freshSession.preparePreferencePublication.bind(freshSession);
freshSession.preparePreferencePublication = (...args) => {
  sessionPublicationPrepares += 1;
  const publication = originalPreparePreferencePublication(...args);
  return { publish() { sessionPublicationPublishes += 1; return publication.publish(); } };
};
const rules = await RuleStore.load(appHome);
// Everything above is fixture setup, not the server's doing.
saveCalls = 0;

const openRouter = new OpenRouterService(undefined);
const guiModel = Object.freeze({
  id: MODEL_ID,
  name: "GUI Main",
  description: "Synthetic priced model for the GUI protocol pins.",
  contextLength: 128_000,
  promptPrice: 0.000003,
  completionPrice: 0.000015,
  supportedParameters: ["tools"],
  inputModalities: ["text"],
  outputModalities: ["text"],
});
openRouter.listModels = async () => [guiModel];
// A cached balance the status pin can read without a network call. The key
// carries `creatorUserId`, which must never leave the process.
// The `error-body` scenario: a failure shaped like a real provider
// rejection — a request id and a response body in the message, which is
// exactly the text the repo's privacy contract (commands.ts:5305-5307) bans
// from any surface.
const PROVIDER_ERROR = Object.assign(
  new Error(
    "OpenRouter 429 request_id=req_SECRET_REQUESTID_CANARY body="
    + JSON.stringify({ error: { message: "upstream said SECRET_PROVIDER_BODY_CANARY" } }),
  ),
  {
    status: 429,
    requestId: "req_SECRET_REQUESTID_CANARY",
    body: { error: { message: "upstream said SECRET_PROVIDER_BODY_CANARY" } },
  },
);
const DESKTOP_PRIVATE_ERROR = Object.assign(
  new Error(
    "desktop setup failed account=acct_or_DESKTOP_ACCOUNT_CANARY "
    + "request_id=req_DESKTOP_REQUEST_CANARY body=DESKTOP_PROVIDER_BODY_CANARY",
  ),
  {
    accountFingerprint: "acct_or_DESKTOP_ACCOUNT_CANARY",
    requestId: "req_DESKTOP_REQUEST_CANARY",
    body: { error: "DESKTOP_PROVIDER_BODY_CANARY" },
  },
);

openRouter.checkBalance = async () => {
  if (scenario === "error-body") throw PROVIDER_ERROR;
  // A provider read that never answers: teardown must not wait on it.
  if (scenario === "hanging-balance") return new Promise(() => {});
  return checkBalanceResult();
};
const checkBalanceResult = () => ({
  key: { label: "gui-fixture", creatorUserId: "SECRET_CREATOR_CANARY" },
  credits: { totalCredits: 20, totalUsage: 5, remaining: 15 },
});

/**
 * The fake keyring: an in-memory store plus a credential intent port that
 * accepts a candidate without a network call. It records only the LENGTH of
 * whatever was submitted — a fixture that kept the value would be the very
 * leak the redaction pin is looking for.
 */
let submittedSecretLength = null;
let providerCredentialCalls = 0;
const credentials = {
  location: "the test keyring",
  async has() { genericCredentialCalls += 1; credentialMethodCalls.has += 1; return false; },
  async get() { genericCredentialCalls += 1; credentialMethodCalls.get += 1; return null; },
  async set() { genericCredentialCalls += 1; credentialMethodCalls.set += 1; },
  async delete() { genericCredentialCalls += 1; credentialMethodCalls.delete += 1; return false; },
  async forget() { genericCredentialCalls += 1; credentialMethodCalls.delete += 1; return false; },
  reserveSlot(kind) { credentialMethodCalls.reserveSlot += 1; return { version: 1, kind, id: `fake:${kind}` }; },
  async readSlot() { credentialMethodCalls.readSlot += 1; return null; },
  async writeSlot() { credentialMethodCalls.writeSlot += 1; },
  async deleteSlot() { credentialMethodCalls.deleteSlot += 1; return false; },
  async getOrCreateAccountHmacKey() { credentialMethodCalls.hmac += 1; return new Uint8Array(32); },
};

let realModelRuntime = null;
let modelTransactionAppHome = null;
let settingsKimiTargetRoute = null;
let settingsKimiAdapterActivations = 0;
if (scenario === "desktop-deferred-model-command") {
  const connectionId = "gui-fixture";
  const credentialPointer = "v1:inference:90000000-0000-4000-8000-000000000099";
  const initialState = {
    schemaVersion: 3,
    revision: 1,
    lifecycle: "configured",
    connections: [{
      id: connectionId, backendId: "openrouter", enabled: true, maturity: "stable",
      credentialBinding: { kind: "orcode-keychain", pointer: credentialPointer },
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified", billingRealm: "openrouter-payg",
      lastHealth: {
        credential: "valid", connectivity: "connected", spend: "available", runtime: "ready",
        observedAt: 1, generation: 1,
      },
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  freshSession.setPreferences(MODEL_ID, { mode: "auto" }, route);
  await freshSession.save();
  const slots = new Map([[credentialPointer, "synthetic-gui-model-secret"]]);
  let sequence = 1;
  const modelCredentials = {
    location: "synthetic-versioned-store",
    async get() { return null; }, async set() {}, async delete() { return false; }, async has() { return false; },
    reserveSlot(kind) {
      return Object.freeze({ version: 1, kind, id: `v1:${kind}:91919191-9191-4191-8191-${String(sequence++).padStart(12, "0")}` });
    },
    async writeSlot(slot, value) { slots.set(slot.id, value); },
    async readSlot(slot) { return slots.get(slot.id) ?? null; },
    async deleteSlot(slot) { return slots.delete(slot.id); },
    async getOrCreateAccountHmacKey() { return new Uint8Array(32).fill(7); },
  };
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState(), {
    persist: (request) => persistProviderSetupState(configPath, request),
  });
  await stateStore.commit(0, (current) => ({ ...structuredClone(initialState), revision: current.revision }));
  persisted.providerSetup = stateStore.read();
  let coordinator;
  const credentialAuthority = new ProviderCredentialAuthority({
    stateStore, credentials: modelCredentials, environment: {}, coordinator: () => coordinator,
  });
  let candidateSequence = 1;
  const adapter = {
    backendId: "openrouter",
    async inspect(request) {
      return {
        routeEligible: true, accountFingerprint: route.accountFingerprint,
        billingRealm: "openrouter-payg",
        health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready", observedAt: 2, generation: request.generation },
      };
    },
    async reconnect() { throw new Error("unused GUI model reconnect"); },
    async bindRuntime() {}, async logout() {}, async discardCandidate() {},
    async connect(request) {
      return {
        candidateId: `gui-model-candidate-${candidateSequence++}`, backendId: "openrouter", connectionId,
        accountFingerprint: route.accountFingerprint, billingRealm: "openrouter-payg",
        health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready", observedAt: 2, generation: request.generation },
      };
    },
    async listModels() {
      return [route, { ...route, requestedModelId: ALT_MODEL_ID, canonicalModelId: ALT_MODEL_ID }].map((candidate) => ({
        backendId: "openrouter", requestedModelId: candidate.requestedModelId,
        canonicalModelId: candidate.canonicalModelId, displayName: candidate.requestedModelId,
        capabilities: { textInput: true, textOutput: true, tools: true, reasoning: false },
      }));
    },
    async activate(request) {
      const selected = request.model.requestedModelId === ALT_MODEL_ID
        ? { ...route, requestedModelId: ALT_MODEL_ID, canonicalModelId: ALT_MODEL_ID }
        : route;
      return {
        candidateId: request.candidateId, backendId: "openrouter", connectionId,
        accountFingerprint: route.accountFingerprint, billingRealm: "openrouter-payg", route: selected,
      };
    },
  };
  const registry = new BackendRegistry([{
    descriptor: {
      id: "openrouter", displayName: "OpenRouter", maturity: "stable", connectable: true,
      kind: "raw-model", credentialOwner: "orcode-keychain", billingRealmKind: "api-payg",
      capabilities: { models: true, tools: true, reasoning: true },
    }, adapter,
  }]);
  const runtimeGuard = new SessionProviderRuntimeGuard();
  coordinator = new ProviderActivationCoordinator({
    appHome, configPath, privateStore: new PrivateStore({ root: appHome }), credentials: modelCredentials,
    adapterResolver: () => adapter, stateStore, runtimeGuard, candidateAuthority: credentialAuthority,
    createUuid: () => `92929292-9292-4292-8292-${String(candidateSequence++).padStart(12, "0")}`,
  });
  const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator: coordinator });
  realModelRuntime = new DefaultProviderRuntime(
    new OpenRouterService("synthetic-gui-model-secret"), modelCredentials, registry, stateStore,
    orchestrator, coordinator, runtimeGuard, {}, null, null, MODEL_ID, persisted, freshSession,
    { credentialAuthority, adapter, forgetJournal: {}, async recover() {} },
    "local-interactive-owner",
  );
  realModelRuntime.adoptCredentialActivation(route, true, "synthetic-gui-model-secret");
  await freshSession.save();
  modelTransactionAppHome = appHome;
}

if (scenario === "settings-kimi-switch") {
  const openConnectionId = "91919191-9191-4191-8191-919191919191";
  const kimiConnectionId = "92929292-9292-4292-8292-929292929292";
  const openCredentialPointer = "v1:inference:93939393-9393-4393-8393-939393939393";
  const kimiCredentialPointer = "v1:kimi-code:94949494-9494-4494-8494-949494949494";
  const kimiFingerprint = "KIMI_DESKTOP_PRIVATE_CANARY";
  settingsKimiTargetRoute = Object.freeze({
    version: 1,
    backendId: "kimi-code",
    accountFingerprint: kimiFingerprint,
    billingRealm: "kimi-code-membership-provider-managed-overage",
    requestedModelId: "kimi-for-coding-highspeed",
    canonicalModelId: "kimi-for-coding-highspeed",
    resolutionState: "resolved",
  });
  const initialState = {
    schemaVersion: 3,
    revision: 3,
    lifecycle: "configured",
    connections: [{
      id: openConnectionId,
      backendId: "openrouter",
      enabled: true,
      maturity: "stable",
      credentialBinding: { kind: "orcode-keychain", pointer: openCredentialPointer },
      accountFingerprint: route.accountFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "openrouter-payg",
      lastHealth: {
        credential: "valid", connectivity: "connected", spend: "available", runtime: "ready",
        observedAt: 1, generation: 3,
      },
    }, {
      id: kimiConnectionId,
      backendId: "kimi-code",
      enabled: true,
      maturity: "preview",
      credentialBinding: { kind: "orcode-keychain", pointer: kimiCredentialPointer },
      accountFingerprint: kimiFingerprint,
      accountFingerprintState: "verified",
      billingRealm: "kimi-code-membership-provider-managed-overage",
      lastHealth: {
        credential: "valid", connectivity: "connected", spend: "available", runtime: "not-applicable",
        observedAt: 1, generation: 3,
      },
    }],
    defaultRoute: route,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState(), {
    persist: (request) => persistProviderSetupState(configPath, request),
  });
  await stateStore.commit(0, (current) => ({
    ...structuredClone(initialState),
    revision: current.revision,
  }));
  persisted.mainModel = route.requestedModelId;
  persisted.providerSetup = stateStore.read();
  await config.saveConfig(persisted, configPath);
  freshSession.setPreferences(route.requestedModelId, { mode: "auto" }, route);
  freshSession.armCrossMode({ lead: crossLeadRoute, challenger: crossChallengerRoute });
  await freshSession.save();

  const slots = new Map([
    [openCredentialPointer, "synthetic-openrouter-settings-secret"],
    [kimiCredentialPointer, "synthetic-kimi-settings-secret"],
  ]);
  let slotSequence = 1;
  const modelCredentials = {
    location: "synthetic-versioned-store",
    async get() { return null; }, async set() {}, async delete() { return false; }, async has() { return false; },
    reserveSlot(kind) {
      return Object.freeze({
        version: 1,
        kind,
        id: `v1:${kind}:95959595-9595-4595-8595-${String(slotSequence++).padStart(12, "0")}`,
      });
    },
    async writeSlot(slot, value) { slots.set(slot.id, value); },
    async readSlot(slot) { return slots.get(slot.id) ?? null; },
    async deleteSlot(slot) { return slots.delete(slot.id); },
    async getOrCreateAccountHmacKey() { return new Uint8Array(32).fill(9); },
  };
  let coordinator;
  const credentialAuthority = new ProviderCredentialAuthority({
    stateStore,
    credentials: modelCredentials,
    environment: {},
    coordinator: () => coordinator,
  });
  const openAdapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("unused OpenRouter inspection"); },
    async reconnect() { throw new Error("unused OpenRouter reconnect"); },
    async bindRuntime() {}, async logout() {}, async discardCandidate() {},
    async connect() { throw new Error("unused OpenRouter connect"); },
    async listModels() { return []; },
    async activate() { throw new Error("unused OpenRouter activation"); },
  };
  const kimiModel = KIMI_CODE_MODELS.find((model) => model.id === settingsKimiTargetRoute.requestedModelId);
  if (!kimiModel) throw new Error("synthetic Kimi Settings target is missing");
  const kimiAdapter = {
    backendId: "kimi-code",
    async inspect() { throw new Error("unused Kimi inspection"); },
    async inspectUnderAuthorityLease() { throw new Error("unused retained Kimi inspection"); },
    async reconnect() { throw new Error("unused Kimi reconnect"); },
    async bindRuntime() {}, async logout() {}, async discardCandidate() {},
    async connect(request) {
      return {
        candidateId: "kimi-gui-settings-candidate",
        backendId: "kimi-code",
        connectionId: kimiConnectionId,
        accountFingerprint: kimiFingerprint,
        billingRealm: "kimi-code-membership-provider-managed-overage",
        health: {
          credential: "valid", connectivity: "connected", spend: "available", runtime: "not-applicable",
          observedAt: 2, generation: request.generation,
        },
      };
    },
    async listModels() {
      return [{
        backendId: "kimi-code",
        requestedModelId: kimiModel.id,
        canonicalModelId: kimiModel.id,
        displayName: kimiModel.displayName,
        capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
      }];
    },
    async activate(request) {
      settingsKimiAdapterActivations += 1;
      return {
        candidateId: request.candidateId,
        backendId: "kimi-code",
        connectionId: kimiConnectionId,
        accountFingerprint: kimiFingerprint,
        billingRealm: "kimi-code-membership-provider-managed-overage",
        route: {
          ...settingsKimiTargetRoute,
          requestedModelId: request.model.requestedModelId,
          canonicalModelId: request.model.canonicalModelId,
        },
      };
    },
  };
  const registry = new BackendRegistry([{
    descriptor: {
      id: "openrouter", displayName: "OpenRouter", maturity: "stable", connectable: true,
      kind: "raw-model", credentialOwner: "orcode-keychain", billingRealmKind: "api-payg",
      capabilities: { models: true, tools: true, reasoning: true },
    },
    adapter: openAdapter,
  }, {
    descriptor: KIMI_CODE_DESCRIPTOR,
    adapter: kimiAdapter,
  }]);
  const runtimeGuard = new SessionProviderRuntimeGuard();
  coordinator = new ProviderActivationCoordinator({
    appHome,
    configPath,
    privateStore: new PrivateStore({ root: appHome }),
    credentials: modelCredentials,
    adapterResolver: (backendId) => backendId === "kimi-code" ? kimiAdapter : openAdapter,
    stateStore,
    runtimeGuard,
    candidateAuthority: credentialAuthority,
    createUuid: () => `96969696-9696-4696-8696-${String(slotSequence++).padStart(12, "0")}`,
  });
  const orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator: coordinator });
  realModelRuntime = new DefaultProviderRuntime(
    new OpenRouterService("synthetic-openrouter-settings-secret"),
    modelCredentials,
    registry,
    stateStore,
    orchestrator,
    coordinator,
    runtimeGuard,
    {},
    null,
    null,
    route.requestedModelId,
    persisted,
    freshSession,
    {
      credentialAuthority,
      adapter: openAdapter,
      kimiAdapter,
      forgetJournal: {},
      async recover() {},
    },
    "local-interactive-owner",
  );
  realModelRuntime.adoptCredentialActivation(route, true, "synthetic-openrouter-settings-secret");
  await freshSession.save();
  modelTransactionAppHome = appHome;
  sessionPublicationPrepares = 0;
  sessionPublicationPublishes = 0;
}

const desktopRoutePickerAuthoritySource = createRoutePickerAuthority({
  capture() {
    routePickerCaptureCalls += 1;
    let source = structuredClone(desktopSnapshot);
    if (scenario === "cross" || scenario === "cross-armed" || scenario === "cross-slow"
      || scenario === "cross-preflight" || scenario === "route-picker-reorder" || scenario === "desktop-deferred-model-command" || scenario === "route-picker-main-no-tools"
      || scenario === "route-picker-compressor-no-tools") {
      source.providers = source.providers.map((provider) => provider.providerId !== "openrouter" ? provider : ({
        ...provider,
        routes: [...provider.routes, {
          ...desktopCandidate("alternate-target"), canonicalModelId: ALT_MODEL_ID,
          displayName: scenario.startsWith("cross") ? "GUI Main" : "GUI Alternate",
          cost: { kind: "unknown", label: "Kosten unbekannt" },
        }],
      }));
    }
    if (scenario === "route-picker-atomic-ambiguity") {
      source.providers = source.providers.map((provider) => provider.providerId !== "openrouter" ? provider : ({
        ...provider,
        routes: ["atomic-account-a", "atomic-account-b"].map((connectionId) => ({
          ...desktopCandidate(`atomic-${connectionId}`), connectionId,
          accountLabel: connectionId, canonicalModelId: MODEL_ID,
          displayName: "Atomic shared model",
        })),
      }));
      if (routePickerCaptureCalls === 1) {
        atomicRaceInitialMatchingRows = source.providers.flatMap((provider) => provider.routes)
          .filter((candidate) => candidate.canonicalModelId === MODEL_ID).length;
      }
      if (routePickerCaptureCalls >= 3) {
        if (routePickerCaptureCalls === 3) atomicRaceEpochChanges += 1;
        source.revision += 1;
        source.providers = source.providers.map((provider) => ({ ...provider,
          routes: provider.routes.map((candidate) => ({ ...candidate, handle: `rebound-${candidate.handle}` })),
        }));
      }
    }
    if (scenario === "route-picker-known-policy") {
      source.providers = source.providers.map((provider) => ({
        ...provider,
        routes: provider.routes.map((candidate) => ({
          ...candidate,
          cost: { kind: "known", label: "OpenRouter-Tarif", source: "provider" },
          dataPolicy: { kind: "known", label: "OpenRouter Datenschutz", source: "provider" },
        })),
      }));
    }
    if (scenario === "cross-kimi-desktop" || scenario === "route-picker-kimi-trap") {
      source.providers.push({
        ...disabledKimiProvider,
        connectionId: "owner-kimi-connection",
        routes: [{
          ...desktopCandidate("desktop-disabled-kimi"), providerId: "kimi-code",
          connectionId: "owner-kimi-connection", accountLabel: "Kimi membership",
          canonicalModelId: "moonshotai/kimi-k3", displayName: "Kimi K3",
          runnable: false, disabled: disabledKimiProvider.disabled,
        }],
      });
    }
    if (scenario === "settings-kimi-switch") {
      source.providers.push({
        providerId: "kimi-code",
        connectionId: "92929292-9292-4292-8292-929292929292",
        accountLabel: "Persönliches Kimi Code",
        state: "ready",
        setupMethods: ["kimi-owner-connect"],
        multiProfile: { enabled: false },
        routes: [{
          ...desktopCandidate("settings-runnable-kimi"),
          providerId: "kimi-code",
          connectionId: "92929292-9292-4292-8292-929292929292",
          accountLabel: "Persönliches Kimi Code",
          canonicalModelId: settingsKimiTargetRoute.canonicalModelId,
          displayName: "Kimi for Coding Highspeed",
          cost: { kind: "known", label: "Kimi-Code-Mitgliedschaft", source: "subscription" },
        }],
      });
    }
    if (scenario === "route-picker-main-no-tools" || scenario === "route-picker-compressor-no-tools") {
      source.providers = source.providers.map((provider) => ({
        ...provider,
        routes: provider.routes.map((candidate) => ({ ...candidate, capabilities: ["text"] })),
      }));
    }
    if (scenario === "route-picker-compressor-foreign") {
      source.providers = source.providers.map((provider) => provider.providerId !== "openrouter" ? provider : ({
        ...provider,
        routes: [...provider.routes, {
          ...desktopCandidate("foreign-owner-handle"), connectionId: "foreign-owner",
          accountLabel: "Foreign account", canonicalModelId: ALT_MODEL_ID,
          displayName: "Foreign compressor", cost: { kind: "unknown", label: "Kosten unbekannt" },
        }],
      }));
    }
    if (scenario === "route-picker-final-view-drift") {
      source.providers = source.providers.map((provider) => provider.providerId !== "openrouter" ? provider : ({
        ...provider, routes: [{ ...desktopCandidate("final-drift"), canonicalModelId: MODEL_ID }],
      }));
      if (routePickerCaptureCalls >= 3) {
        source.revision += 1;
        source.providers = source.providers.map((provider) => ({ ...provider,
          routes: provider.routes.map((candidate) => ({ ...candidate, handle: `final-${candidate.handle}` })),
        }));
      }
    }
    if (scenario === "route-picker-reorder" && routePickerCaptureCalls > 1) {
      source.revision += 1;
      source.providers = source.providers.map((provider) => ({
        ...provider,
        routes: [...provider.routes].reverse().map((candidate) => ({
          ...candidate, handle: `rebound-${candidate.handle}`,
        })),
      }));
    }
    const bindings = new Map();
    for (const candidate of source.providers.flatMap((provider) => provider.routes)) {
      const accountFingerprint = scenario.startsWith("cross") && candidate.canonicalModelId === ALT_MODEL_ID
        ? crossChallengerRoute.accountFingerprint
        : scenario.startsWith("cross") && candidate.canonicalModelId === MODEL_ID
          ? crossLeadRoute.accountFingerprint
          : candidate.connectionId === "atomic-account-b"
            ? "acct_or_ATOMIC_ACCOUNT_B"
            : candidate.providerId === "kimi-code"
              ? "KIMI_DESKTOP_PRIVATE_CANARY"
              : candidate.connectionId === "foreign-owner"
                ? "acct_or_FOREIGN_OWNER_PRIVATE_CANARY"
                : route.accountFingerprint;
      bindings.set(candidate.handle, {
        connectionId: candidate.connectionId,
        route: {
          ...route,
          accountFingerprint,
          backendId: candidate.providerId,
          requestedModelId: candidate.canonicalModelId,
          canonicalModelId: candidate.canonicalModelId,
          billingRealm: candidate.providerId === "kimi-code"
            ? "kimi-code-membership-provider-managed-overage" : "openrouter-payg",
        },
      });
    }
    if (scenario === "route-picker-kimi-trap") {
      const kimi = source.providers.flatMap((provider) => provider.routes).find((candidate) =>
        candidate.providerId === "kimi-code"
        && candidate.canonicalModelId === "moonshotai/kimi-k3"
        && candidate.runnable === false
        && candidate.disabled?.code === "native-local-action-unavailable"
        && candidate.disabled?.label === "Kimi Code kann nur im lokalen Eigentümer-Terminal eingerichtet werden.");
      const binding = kimi ? bindings.get(kimi.handle) : null;
      desktopDisabledKimiBindingProven = Boolean(
        kimi
        && binding?.connectionId === kimi.connectionId
        && binding.route.accountFingerprint === "KIMI_DESKTOP_PRIVATE_CANARY",
      );
    }
    return { snapshot: source, bindings };
  },
});
const desktopRoutePickerAuthority = {
  view(request) { desktopRoutePickerViewCalls += 1; return desktopRoutePickerAuthoritySource.view(request); },
  resolve(request, selection) { desktopRoutePickerResolveCalls += 1; return desktopRoutePickerAuthoritySource.resolve(request, selection); },
};

const ownerRoutePickerAuthoritySource = createRoutePickerAuthority({
  capture() {
    const candidate = {
      ...desktopCandidate("owner-runnable-kimi"), providerId: "kimi-code",
      connectionId: "owner-kimi-connection", accountLabel: "Kimi membership",
      canonicalModelId: "moonshotai/kimi-k3", displayName: "Kimi K3", runnable: true,
    };
    return {
      snapshot: {
        ...structuredClone(desktopSnapshot),
        providers: [{
          providerId: "kimi-code", connectionId: "owner-kimi-connection",
          accountLabel: "Kimi membership", state: "ready", setupMethods: ["kimi-owner-connect"],
          multiProfile: { enabled: false }, routes: [candidate],
        }],
      },
      bindings: new Map([[candidate.handle, {
        connectionId: candidate.connectionId,
        route: {
          version: 1, backendId: "kimi-code", accountFingerprint: "KIMI_OWNER_PRIVATE_CANARY",
          billingRealm: "kimi-code-membership-provider-managed-overage",
          requestedModelId: candidate.canonicalModelId, canonicalModelId: candidate.canonicalModelId,
          resolutionState: "resolved",
        },
      }]]),
    };
  },
});
const ownerRoutePickerAuthority = {
  view(request) { terminalOwnerViewCalls += 1; return ownerRoutePickerAuthoritySource.view(request); },
  resolve(request, selection) { terminalOwnerResolveCalls += 1; return ownerRoutePickerAuthoritySource.resolve(request, selection); },
};
if (scenario === "cross-kimi-desktop" || scenario === "route-picker-kimi-trap" || scenario === "route-picker-missing-desktop") {
  const view = ownerRoutePickerAuthority.view({ role: "lead" });
  const candidate = view.candidates.find((row) => row.providerId === "kimi-code" && row.runnable);
  ownerKimiRunnableBaseline = Boolean(candidate
    && ownerRoutePickerAuthority.resolve({ role: "lead" }, {
      handle: candidate.handle, revision: view.revision, generation: view.generation,
    }).route.backendId === "kimi-code");
  terminalOwnerViewCalls = 0;
  terminalOwnerResolveCalls = 0;
}

const runtime = {
  openRouter,
  credentials,
  providerCredentials: {
    async apply(request) {
      providerCredentialCalls += 1;
      if (typeof request?.candidate === "string") {
        submittedSecretLength = request.candidate.length;
      }
      return { persisted: true, balance: null };
    },
  },
  preparedRoles: null,
  kimiCrossExecutionMode() {
    return scenario === "cross-kimi-missing-claim" ? "desktop-private" : "unavailable";
  },
  async inspectStartup() {
    if (startupInspectionHeldScenario) {
      startupInspectionStarted += 1;
      process.stderr.write("ORCODE_GUI_GATE:startup-inspection-held\n");
      await startupInspectionBarrier;
      startupInspectionReleased += 1;
    }
    return {
      mode: "ready",
      generation: 1,
      defaultRoute: route,
      readyRoutes: [route],
      warnings: [],
      crossEnabled: false,
    };
  },
  async resolveLegacyDefaultRoute() { return this.inspectStartup(); },
  async runSetup() { return { kind: "ready", route }; },
  async runDesktopOpenRouterSetup(surface, signal) {
    desktopSetupCalls += 1;
    desktopSetupEntered += 1;
    desktopActiveOperations += 1;
    process.stderr.write("ORCODE_GUI_GATE:setup-entered\n");
    const abort = () => { desktopSetupAborted += 1; };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return { kind: "cancelled", mode: "setup-required" };
      const secret = await surface.readSecret({
        backendId: "openrouter",
        message: "OpenRouter API key",
      });
      if (secret === null || signal.aborted) return { kind: "cancelled", mode: "setup-required" };
      const selected = await surface.chooseModel({
        backendId: "openrouter",
        models: [{
          requestedModelId: MODEL_ID,
          canonicalModelId: MODEL_ID,
          displayName: "GUI Main",
          capabilities: { text: true, tools: true },
        }],
      });
      if (selected === null || signal.aborted) return { kind: "cancelled", mode: "setup-required" };
      if (scenario === "desktop-empty-private-failure") throw DESKTOP_PRIVATE_ERROR;
      if (scenario === "desktop-empty-foreign-route") {
        process.stderr.write("ORCODE_GUI_GATE:empty-setup-held\n");
        await new Promise((resolve) => { releaseForeignDesktopSetup = resolve; });
        throw new Error("fixture outer setup rejection after foreign route switch");
      }
      const committedRevision = scenario === "desktop-empty-stale-cancel" ? 5 : 2;
      const committedGeneration = scenario === "desktop-empty-stale-cancel" ? 4 : 2;
      desktopSnapshot = readyDesktopSnapshot(committedRevision, committedGeneration, "route-after-setup");
      const proof = {
        routeHandle: "route-after-setup",
        revision: committedRevision,
        generation: committedGeneration,
      };
      desktopCancelCallsBeforeSetupSettlement = desktopCancelCalls;
      if (scenario === "desktop-empty-durable-cancelled") {
        const result = { kind: "cancelled", mode: "setup-required" };
        desktopSetupCommitProofs.set(result, proof);
        return result;
      }
      if (scenario === "desktop-empty-durable-throw") {
        const error = new Error("legacy outer setup return failed after commit");
        desktopSetupCommitProofs.set(error, proof);
        throw error;
      }
      const result = { kind: "ready" };
      desktopSetupCommitProofs.set(result, proof);
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      desktopSetupAbortListenersRemoved += 1;
      desktopSetupSettled += 1;
      desktopActiveOperations -= 1;
      process.stderr.write("ORCODE_GUI_GATE:setup-settled\n");
    }
  },
  async runDesktopNanoGptSetup(surface, signal) {
    desktopNanoSetupCalls += 1;
    if (!desktopNanoScenario || signal.aborted) return { kind: "cancelled", mode: "setup-required" };
    const billing = await surface.chooseHub([
      { id: "nano-gpt:subscription", label: "Abo · kein Guthaben-Fallback", description: "Abo-Schlüssel: Guthaben-Ausgaben deaktiviert · Getrennte Verbindung", disabled: false, current: false, generation: desktopSnapshot.generation },
      { id: "nano-gpt:payg", label: "Guthaben · Pay-as-you-go", description: "Ausdrücklich aus dem Nano-GPT-Guthaben bezahlen · Getrennte Verbindung", disabled: false, current: false, generation: desktopSnapshot.generation },
    ]);
    if (signal.aborted || (billing !== "nano-gpt:subscription" && billing !== "nano-gpt:payg")) return { kind: "cancelled", mode: "setup-required" };
    desktopNanoBillingMode = billing === "nano-gpt:subscription" ? "subscription" : "payg";
    const secret = await surface.readSecret({ backendId: "nano-gpt", message: "Nano-GPT API-Schlüssel" });
    if (signal.aborted || secret === null) return { kind: "cancelled", mode: "setup-required" };
    desktopNanoSecretLength = secret.length;
    const selected = await surface.chooseModel({ backendId: "nano-gpt", models: [{ backendId: "nano-gpt", requestedModelId: "vendor/nano-manual", canonicalModelId: "vendor/nano-manual", displayName: "Nano manual", capabilities: { textInput: true, textOutput: true, tools: true, reasoning: false } }] });
    if (signal.aborted || selected !== "vendor/nano-manual") return { kind: "cancelled", mode: "setup-required" };
    desktopNanoSelectedModel = selected;
    desktopSnapshot = { ...desktopSnapshot, revision: desktopSnapshot.revision + 1, generation: desktopSnapshot.generation + 1,
      routeRunnable: true, activeRoute: { routeHandle: "nano-route-ready", providerLabel: "Nano-GPT", modelLabel: "Nano manual", accountLabel: `Nano-GPT ${desktopNanoBillingMode}` },
      providers: desktopSnapshot.providers.map((provider) => provider.providerId === "nano-gpt" ? desktopNanoProvider(true, desktopNanoBillingMode) : provider),
    };
    const result = { kind: "ready" };
    desktopSetupCommitProofs.set(result, { routeHandle: "nano-route-ready", revision: desktopSnapshot.revision, generation: desktopSnapshot.generation });
    return result;
  },
  reconcileDesktopNanoGptSetupCommit(settlement) {
    const proof = settlement && typeof settlement === "object" ? desktopSetupCommitProofs.get(settlement) : null;
    if (settlement && typeof settlement === "object") desktopSetupCommitProofs.delete(settlement);
    if (!proof || !desktopSnapshot.routeRunnable || desktopSnapshot.activeRoute?.routeHandle !== proof.routeHandle || desktopSnapshot.revision !== proof.revision || desktopSnapshot.generation !== proof.generation) return null;
    desktopNanoCommitAccepted += 1;
    return structuredClone(proof);
  },
  reconcileDesktopOpenRouterSetupCommit(settlement) {
    desktopSetupProofReconciliations += 1;
    if ((typeof settlement !== "object" || settlement === null) && typeof settlement !== "function") return null;
    const proof = desktopSetupCommitProofs.get(settlement);
    desktopSetupCommitProofs.delete(settlement);
    if (!proof
      || !desktopSnapshot.routeRunnable
      || desktopSnapshot.activeRoute?.routeHandle !== proof.routeHandle
      || desktopSnapshot.revision !== proof.revision
      || desktopSnapshot.generation !== proof.generation) return null;
    desktopSetupProofAccepted += 1;
    return structuredClone(proof);
  },
  async connectDesktopCodex(method, signal) {
    if (scenario !== "desktop-codex-login" && scenario !== "desktop-codex-login-durable-cancel") throw new Error("Codex native fixture unavailable");
    if (signal?.aborted) throw signal.reason;
    desktopCodexLoginCalls++;
    desktopCodexLoginMethod = method;
    desktopSnapshot = { ...desktopSnapshot, revision: desktopSnapshot.revision + 1,
      providers: desktopSnapshot.providers.map((provider) => ({ ...provider, state: "ready",
        connectionId: "codex-first-profile", accountLabel: "Persönliches ChatGPT" })) };
    if (scenario === "desktop-codex-login-durable-cancel") {
      process.stderr.write("ORCODE_GUI_GATE:codex-profile-retained\n");
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
  },
  desktopOnboardingAuthority() {
    return {
      snapshot() {
        if (scenario === "desktop-empty-foreign-route" && releaseForeignDesktopSetup) {
          const release = releaseForeignDesktopSetup;
          releaseForeignDesktopSetup = undefined;
          desktopSnapshot = readyDesktopSnapshot(2, 2, "route-foreign");
          release();
        }
        if (reverseMutationWaiting) releaseReverseMutation();
        if (desktopFinalizeSnapshotFailureArmed) {
          desktopFinalizeSnapshotFailureArmed = false;
          throw new Error("UNRELATED_FINAL_SNAPSHOT_FAILURE");
        }
        return structuredClone(desktopSnapshot);
      },
      async refreshAccount(selection, signal) {
        if (selection.providerId === "kimi-code") enterKimiEffectTrap("catalogue");
        desktopCatalogueCalls += 1;
        desktopRefreshCalls += 1;
        if (scenario === "desktop-old-route-refresh" || scenario === "desktop-old-route-refresh-finalize-failure") {
          desktopActiveOperations += 1;
          try {
            await new Promise((_resolve, reject) => {
              const abort = () => {
                desktopRefreshAborted += 1;
                reject(signal?.reason ?? new Error("aborted"));
              };
              signal?.addEventListener("abort", abort, { once: true });
            });
          } finally {
            desktopActiveOperations -= 1;
          }
        }
        if (signal?.aborted) throw signal.reason ?? new Error("aborted");
        if (scenario === "desktop-refresh-external" || scenario === "desktop-refresh-deferred") {
          if (scenario === "desktop-refresh-deferred") {
            process.stderr.write("ORCODE_GUI_GATE:refresh-started\n");
          }
          desktopSnapshot = {
            ...readyDesktopSnapshot(2, 2, "route-external"),
            routeRunnable: false,
            activeRoute: null,
            providers: [desktopProvider(desktopCandidate("route-external"))],
          };
          desktopActiveOperations += 1;
          let abort;
          try {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, scenario === "desktop-refresh-external" ? 200 : 20_000);
              abort = () => {
                clearTimeout(timer);
                desktopRefreshAborted += 1;
                reject(signal?.reason ?? new Error("aborted"));
              };
              signal?.addEventListener("abort", abort, { once: true });
            });
          } finally {
            desktopActiveOperations -= 1;
            if (abort) {
              signal?.removeEventListener("abort", abort);
              desktopAbortListenersRemoved += 1;
            }
          }
        }
        return structuredClone(desktopSnapshot);
      },
      async cancelActivation() {
        desktopCancelCalls += 1;
        if (scenario === "desktop-old-route-refresh-finalize-failure") {
          desktopFinalizeSnapshotFailureArmed = true;
        }
        if (scenario === "desktop-old-route-model" || scenario === "desktop-old-route-model-failure"
          || scenario === "desktop-old-route-model-late-failure") {
          desktopActivationReject?.(
            scenario === "desktop-old-route-model-failure" || scenario === "desktop-old-route-model-late-failure"
              ? new Error("UNRELATED_OPERATION_FAILURE")
              : desktopActivationSignal?.reason ?? new Error("activation cancelled"),
          );
          desktopActivationReject = null;
          if (scenario === "desktop-old-route-model-failure") {
            throw new Error("UNRELATED_AUTHORITY_CANCEL_FAILURE");
          }
          return "cancelled";
        }
        if ((scenario === "desktop-durable-cancel" || scenario === "desktop-old-route-model-durable"
          || scenario === "desktop-activation-fail-once-durable") && desktopSnapshot.routeRunnable) {
          return "completion-committed";
        }
        return "none";
      },
      async activate(selection, signal) {
        if (selection.providerId === "kimi-code") enterKimiEffectTrap("credential");
        desktopActivationCalls += 1;
        desktopActivationSignal = signal;
        if ((scenario === "desktop-activation-fail-once" || scenario === "desktop-activation-fail-once-durable")
          && desktopActivationCalls === 1) {
          throw new Error("PRIVATE_DESKTOP_ACTIVATION_FAILURE");
        }
        if (scenario === "desktop-old-route-model" || scenario === "desktop-old-route-model-failure"
          || scenario === "desktop-old-route-model-late-failure") {
          process.stderr.write(`ORCODE_GUI_GATE:activation-held:${desktopActivationCalls}\n`);
          desktopActiveOperations += 1;
          try {
            await new Promise((_resolve, reject) => { desktopActivationReject = reject; });
          } finally {
            desktopActiveOperations -= 1;
          }
        }
        if (selection.routeHandle !== "route-before" && selection.routeHandle !== "route-b-before") {
          throw new Error("stale route handle");
        }
        desktopSnapshot = readyDesktopSnapshot(
          2,
          2,
          scenario === "desktop-old-route-model-reused" ? "route-b-before" : "route-after",
        );
        if (scenario === "desktop-activation-fail-once-durable") {
          process.stderr.write("ORCODE_GUI_GATE:activation-committed\n");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (scenario === "desktop-durable-cancel" || scenario === "desktop-old-route-model-durable") {
          process.stderr.write("ORCODE_GUI_GATE:activation-committed\n");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (scenario === "desktop-old-route-model-reused") {
          process.stderr.write("ORCODE_GUI_GATE:activation-committed\n");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (signal?.aborted) throw signal.reason;
        return { routeHandle: "route-after", revision: 2, generation: 2 };
      },
    };
  },
  routePickerAuthority() { desktopAuthorityGetterCalls += 1; return scenario === "route-picker-missing-desktop" ? undefined : desktopRoutePickerAuthority; },
  terminalOwnerRoutePickerAuthority() {
    terminalOwnerAuthorityCalls += 1;
    return ownerRoutePickerAuthority;
  },
  ensureRunnableRoute() {
    if (realModelRuntime) return realModelRuntime.ensureRunnableRoute();
    if (!desktopSnapshot.routeRunnable || scenario.startsWith("desktop-proof-fails")) {
      throw new Error("No runnable route is available.");
    }
    return route;
  },
  currentSessionRoute() { return realModelRuntime ? realModelRuntime.currentSessionRoute() : route; },
  hasRunnableRoute() {
    // In the setup scenarios the fixture home starts with NO connected route,
    // which is what makes the hub's setup affordance and `routeConnected:
    // false` the honest state to pin.
    return setupWorld ? setupWorld.stateStore.read().defaultRoute !== null : true;
  },
  modelRuntime(route) {
    // `cross-slow` needs the Cross worker to actually REACH an agent, so this
    // scenario hands back a runtime carrying a real binding identity (the one
    // `readModelRuntimeIdentity` reads, and `assertCurrentBinding` re-reads).
    // Every other scenario keeps the inert stub, which is what makes their
    // Cross runs end in milliseconds.
    return scenario === "cross-slow" || scenario === "cross-preflight"
      ? boundCrossRuntime(route)
      : {};
  },
  adoptSession() {
    adoptSessionCalls += 1;
    if (scenario === "desktop-deferred-chat-switch") desktopChatMutationCalls += 1;
  },
  migratedSessionConnection() { return undefined; },
  async selectSessionRoute(next) {
    if (scenario === "desktop-deferred-chat-switch") {
      desktopRerootCalls += 1;
      reverseMutationWaiting = true;
      process.stderr.write("ORCODE_GUI_GATE:chat-mutation-held\n");
      await reverseMutationHeld;
    }
    return next;
  },
  // Present so `/model` takes the REAL branch: the one that reaches
  // `context.modelRoutePicker` (commands.ts's gate needs all four of
  // listSelectableModelRoutes / transitionSessionRoute /
  // readModelPreferenceAuthority / prepareSettingsModelPublication).
  async transitionSessionRoute(next) {
    transitionEntries += 1;
    if (realModelRuntime) {
      if (scenario === "desktop-deferred-model-command") {
        reverseMutationWaiting = true;
        process.stderr.write("ORCODE_GUI_GATE:model-command-held\n");
        await reverseMutationHeld;
      }
      const transitioned = await realModelRuntime.transitionSessionRoute(...arguments);
      modelTransitions.push(transitioned.requestedModelId);
      return transitioned;
    }
    modelTransitions.push(next.requestedModelId);
    return next;
  },
  async runWithReadyRoute(run) { return run(route); },
  activity() { return { runActive: false, activationHeld: false }; },
  async runSettingsConfigMutation(task) {
    configMutationCalls += 1;
    if (settingsTimeoutReleaseScenario) {
      settingsMutationTaskCalls += 1;
      const result = await task();
      settingsMutationHeld += 1;
      process.stderr.write("ORCODE_GUI_GATE:settings-timeout-mutation-held\n");
      await settingsTimeoutMutationBarrier;
      return result;
    }
    if (scenario === "settings-wedged-mutation") {
      settingsMutationHeld += 1;
      process.stderr.write("ORCODE_GUI_GATE:settings-mutation-held\n");
      return new Promise(() => {});
    }
    settingsMutationTaskCalls += 1;
    return realModelRuntime ? realModelRuntime.runSettingsConfigMutation(task) : task();
  },
  readCachedSettingsRoute() {
    return {
      backendId: "openrouter",
      providerLabel: "OpenRouter",
      requestedModelId: route.requestedModelId,
      canonicalModelId: route.canonicalModelId,
      modelLabel: "GUI Main",
      billingRealm: "openrouter-payg",
    };
  },
  readCachedProviderStatus() {
    if (desktopSettingsProviderGuidanceScenario) {
      return [{
        backendId: "openrouter",
        displayName: "OpenRouter",
        availability: "connectable",
        configuration: "not-connected",
        maturity: "stable",
        billingRealm: "openrouter-payg",
        headline: null,
        accountFingerprintSuffix: null,
        health: null,
        isDefault: false,
        allowedActions: ["connect"],
      }, {
        backendId: "kimi-code",
        displayName: "Kimi Code",
        availability: "connectable",
        configuration: "not-connected",
        maturity: "preview",
        billingRealm: "kimi-code-membership-provider-managed-overage",
        headline: null,
        accountFingerprintSuffix: null,
        health: null,
        isDefault: false,
        allowedActions: ["connect"],
      }];
    }
    if (desktopSettingsConnectedProviderGuidanceScenario) {
      return [{
        backendId: "openrouter",
        displayName: "OpenRouter",
        availability: "connectable",
        configuration: "enabled",
        maturity: "stable",
        billingRealm: "openrouter-payg",
        headline: "ready",
        accountFingerprintSuffix: "CANARY",
        health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready" },
        isDefault: true,
        allowedActions: ["reconnect", "models"],
      }];
    }
    return [{
      backendId: "openrouter",
      displayName: "OpenRouter",
      availability: "connectable",
      configuration: "enabled",
      maturity: "stable",
      billingRealm: "openrouter-payg",
      headline: "synthetic runtime",
      accountFingerprintSuffix: "CANARY",
      health: { credential: "valid", connectivity: "connected", spend: "available", runtime: "ready" },
      isDefault: true,
      allowedActions: [],
    }];
  },
  readCachedSettingsModels() { return [guiModel]; },
  async listSelectableModelRoutes() {
    legacyRouteCatalogCalls += 1;
    return [
      {
        route,
        providerLabel: "OpenRouter",
        model: {
          id: MODEL_ID, name: "GUI Main", contextLength: 128_000,
          reasoning: { supported: false },
          price: { kind: "known", promptUsdPerToken: 0.000003, completionUsdPerToken: 0.000015 },
        },
        supportsTools: true,
        supportsReasoning: false,
        selected: true,
      },
      {
        route: { ...route, requestedModelId: ALT_MODEL_ID, canonicalModelId: ALT_MODEL_ID },
        providerLabel: "OpenRouter",
        model: {
          id: ALT_MODEL_ID, name: "GUI Alternate", contextLength: 64_000,
          reasoning: { supported: false },
          price: { kind: "unknown" },
        },
        supportsTools: true,
        supportsReasoning: false,
        selected: false,
      },
    ];
  },
  /**
   * The `cross` scenario ships a COMPLETE pair, so `/cross` opens the real
   * gate instead of the "set both models" refusal. Both routes carry a
   * fingerprint canary: the gate must render model NAMES, never identities.
   */
  readCrossPreferences() {
    crossPreferenceReads += 1;
    return structuredClone(crossPreferences);
  },
  async publishCrossPreferences(next) {
    crossPreferencePublishes += 1;
    crossPreferences = structuredClone(next);
    return structuredClone(next);
  },
  prepareSettingsModelPublication(next) {
    settingsPublicationPrepares += 1;
    const publication = realModelRuntime ? realModelRuntime.prepareSettingsModelPublication(next) : { publish() {} };
    return { publish() { settingsPublicationPublishes += 1; return publication.publish(); } };
  },
  readModelPreferenceAuthority() {
    modelPreferenceAuthorityReads += 1;
    return realModelRuntime
      ? realModelRuntime.readModelPreferenceAuthority()
      : { route, providerRevision: 1, connectionId: "gui-fixture" };
  },
  async transitionSessionModel() { throw new Error("GUI pins must not mutate provider routes"); },
  async execute(intent, surface) {
    // Only the `setup*` scenarios wire a real setup flow; every other pin
    // keeps the refusal, so nothing can reach a provider action by accident.
    if (!setupWorld || intent?.kind !== "setup") {
      throw new Error("GUI pins must not call provider actions");
    }
    const result = await runSetupHub({
      surface,
      orchestrator: setupWorld.orchestrator,
      registry: setupWorld.registry,
      stateStore: setupWorld.stateStore,
      executionMode: setupWorld.executionMode,
    });
    return {
      kind: "setup",
      backendId: setupWorld.lastBackendId ?? "openrouter",
      outcome: result.kind === "ready" ? "ready" : "cancelled",
    };
  },
};

/* -------------------------------------------------------------------------
 * The real setup flow, for the `setup` / `setup-owner` scenarios.
 *
 * `runSetupHub` is the REAL controller: the hub entries, the Kimi
 * execution-mode refusal, the secret stage, the model chooser and every
 * FIX-18 outcome notice are its own. Only the two adapters and the
 * activation coordinator are fixtures, so no network call, no keychain read
 * and no route mutation happens — exactly the discipline the rest of this
 * file already applies to the run path.
 * ---------------------------------------------------------------------- */

const SETUP_OPENROUTER_DESCRIPTOR = {
  id: "openrouter",
  displayName: "OpenRouter",
  maturity: "stable",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "api-payg",
  capabilities: { models: true, tools: true, reasoning: true },
};
const SETUP_ANTHROPIC_DESCRIPTOR = {
  id: "anthropic",
  displayName: "Anthropic / Claude subscription",
  maturity: "coming-soon",
  connectable: false,
  kind: "managed-agent",
  credentialOwner: "none",
  billingRealmKind: "none",
  capabilities: { models: false, tools: false, reasoning: false },
};
const SETUP_KIMI_DESCRIPTOR = {
  id: "kimi-code",
  displayName: "Kimi Code",
  maturity: "preview",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "provider-managed",
  capabilities: { models: true, tools: true, reasoning: true },
};
/**
 * Two OpenRouter rows, and the first is the one that used to be unpickable
 * from this window: `openrouter/auto`'s canonical id differs from its
 * requested id, so an adapter that answered with the requested id could never
 * satisfy `runSetupHub`'s `canonicalModelId ===` match.
 */
const SETUP_MODELS = [
  {
    backendId: "openrouter",
    requestedModelId: "openrouter/auto",
    canonicalModelId: "openrouter/auto:canonical",
    displayName: "Auto",
    capabilities: { textInput: false, textOutput: false, tools: false, reasoning: false },
  },
  {
    backendId: "openrouter",
    requestedModelId: MODEL_ID,
    canonicalModelId: MODEL_ID,
    displayName: "GUI Main",
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: false },
  },
];

let setupSecretLengths = [];
function buildSetupWorld(executionMode) {
  const world = { executionMode, lastBackendId: null };
  const adapter = {
    backendId: "openrouter",
    async inspect() { throw new Error("not used"); },
    async reconnect() { throw new Error("not used"); },
    async logout() {},
    async discardCandidate() {},
    async connect(request) {
      // The fixture records only the LENGTH — keeping the value would be the
      // very leak the redaction pins hunt for.
      setupSecretLengths.push(String(request.candidate).length);
      return {
        candidateId: "candidate",
        backendId: "openrouter",
        connectionId: "connection",
        accountFingerprint: "acct_or_SETUPCANARYFINGERPRINT000000000",
        billingRealm: "openrouter-payg",
        health: {
          credential: "valid", connectivity: "connected", spend: "available",
          runtime: "ready", observedAt: 1, generation: 1,
        },
      };
    },
    async listModels() { return SETUP_MODELS; },
    async activate() { throw new Error("not used"); },
  };
  const kimiAdapter = {
    backendId: "kimi-code",
    async inspect() { throw new Error("not used"); },
    async reconnect() { throw new Error("not used"); },
    async logout() {},
    async discardCandidate() {},
    async connect() { throw new Error("the Kimi path must never be reached here"); },
    async listModels() { return []; },
    async activate() { throw new Error("not used"); },
  };
  const stateStore = new ProviderStateStore(createNeverConfiguredProviderState());
  const registry = new BackendRegistry([
    { descriptor: SETUP_OPENROUTER_DESCRIPTOR, adapter },
    { descriptor: SETUP_KIMI_DESCRIPTOR, adapter: kimiAdapter },
    { descriptor: SETUP_ANTHROPIC_DESCRIPTOR },
  ]);
  const activationCoordinator = {
    async activate(request) {
      world.lastBackendId = "openrouter";
      const activated = {
        version: 1,
        backendId: "openrouter",
        accountFingerprint: "acct_or_SETUPCANARYFINGERPRINT000000000",
        billingRealm: "openrouter-payg",
        requestedModelId: request.expectedRequestedModelId,
        canonicalModelId: request.selectedCanonicalModelId,
        resolutionState: "resolved",
      };
      const previous = stateStore.read();
      const state = stateStore.replace({
        ...previous,
        lifecycle: "configured",
        connections: [{
          id: "connection",
          backendId: "openrouter",
          enabled: true,
          maturity: "stable",
          credentialBinding: {
            kind: "orcode-keychain",
            pointer: "v1:inference:90000000-0000-4000-8000-000000000002",
          },
          accountFingerprint: "acct_or_SETUPCANARYFINGERPRINT000000000",
          accountFingerprintState: "verified",
          billingRealm: "openrouter-payg",
          lastHealth: null,
        }],
        defaultRoute: activated,
        cross: structuredClone(previous.cross),
      }, previous.revision);
      return { persisted: true, warnings: [], state, route: activated };
    },
  };
  world.stateStore = stateStore;
  world.registry = registry;
  world.orchestrator = new SetupOrchestrator({ registry, stateStore, activationCoordinator });
  return world;
}

const setupWorld = scenario === "setup"
  // The mode the GUI sidecar actually derives over a pipe.
  ? buildSetupWorld("piped")
  : scenario === "setup-owner"
    ? buildSetupWorld("local-interactive-owner")
    : null;

/* -------------------------------------------------------------------------
 * `cross-slow`: a Cross run that is actually still running when the shell
 * goes away.
 *
 * The re-review's finding was that the existing `cross-armed` teardown
 * assertion could not discriminate: the fixture pair is refused at
 * `readModelRuntimeIdentity` and the whole run is over in 2-45 ms, so a
 * teardown that never stops Cross passes the pin anyway. This scenario gives
 * the worker adapter what it actually asks for — a runtime carrying a binding
 * identity — and replaces `OrcodeAgent.create` (the one hard-coded factory
 * inside `createCrossRuntimeForContext`) with a worker that settles ONLY when
 * the run is aborted. Two of them, one per role, each holding a detached OS
 * child exactly like a real tool would, so "the workers were still spending"
 * is a state the process table can be asked about.
 * ---------------------------------------------------------------------- */

const crossRuntimes = new Map();
/** Per-canonical-model, so `assertCurrentBinding`'s re-read finds the same one. */
function boundCrossRuntime(route) {
  const key = route?.canonicalModelId ?? "";
  const existing = crossRuntimes.get(key);
  if (existing) return existing;
  const runtime = {
    backendId: "openrouter",
    createClient() { throw new Error("the cross-slow worker never reaches a client"); },
    async inspectSpend() { return { kind: "unavailable" }; },
    async listModels() { return []; },
    dispatchFields() { return { backendId: "openrouter", models: [key] }; },
    onConnectionEvent() { return () => {}; },
    safeMessage(error) { return String(error?.message ?? error); },
  };
  bindModelRuntimeIdentity(runtime, {
    version: 1,
    stateRevision: 1,
    generation: 1,
    connectionId: "gui-fixture",
    backendId: "openrouter",
    route,
  });
  crossRuntimes.set(key, runtime);
  return runtime;
}

/** Live detached children the slow Cross workers hold, by pid. */
const crossWorkerPids = [];
let crossWorkersStarted = 0;
let crossWorkersAborted = 0;

if (scenario === "cross-slow" || scenario === "cross-preflight") {
  OrcodeAgent.create = async () => ({
    setSession() {},
    resetConversationMemory() {},
    guard: {},
    async run(_prompt, observer = {}) {
      crossWorkersStarted += 1;
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000);"],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      crossWorkerPids.push(child.pid);
      const partial = {
        text: "", outcome: "cancelled", costKnowledge: "known",
        costUsd: 0, mainCostUsd: 0, compressorCostUsd: 0,
      };
      return await new Promise((_resolve, reject) => {
        const abort = () => {
          crossWorkersAborted += 1;
          try { process.kill(-child.pid, "SIGKILL"); }
          catch { try { process.kill(child.pid, "SIGKILL"); } catch {} }
          reject(new AgentRunError(new Error("cancelled"), "cancelled", partial));
        };
        if (observer.signal?.aborted) { abort(); return; }
        observer.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
}

let agentCalls = 0;

/**
 * A run that spawns a REAL detached child, exactly the way orcode's own tool
 * shells do (`workspace.ts` spawns with `detached: true` so a timeout can
 * take the whole tree down), and only settles when the run is aborted.
 *
 * This is what makes M1's pin a proof rather than a claim: if teardown does
 * not reach the run's cancel path, this child survives the sidecar and the
 * test can see it in the OS process table.
 */
let toolChildPid = null;
let runOutcome = null;
/** Save count at the instant the run began, so the pin can measure the delta. */
let saveCallsAtRunStart = null;
const longRun = async (prompt, observer = {}) => {
  agentCalls += 1;
  saveCallsAtRunStart = saveCalls;
  const now = Date.now();
  const child = spawn(
    process.execPath,
    // Self-terminating, so a REGRESSION leaves at most a short-lived stray
    // instead of a permanent one on the developer's machine.
    ["-e", "setTimeout(() => process.exit(0), 20000); setInterval(() => {}, 1000);"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  toolChildPid = child.pid;
  observer.onEvent?.({
    type: "run-start", timestamp: now, model: MODEL_ID, maxSteps: 7,
    costKnowledge: "known", prompt,
  });
  observer.onEvent?.({
    type: "process-start", timestamp: now, id: "p9", name: "bash",
    input: { command: "sleep" },
  });
  observer.onStatus?.("Working \u2026");
  observer.onText?.("partial ", "partial ");
  const partial = {
    text: "partial ", suggestions: [], outcome: "cancelled",
    costUsd: 0.001, mainCostUsd: 0.001, compressorCostUsd: 0, costKnowledge: "known",
    compression: { applied: false, warnings: [] },
    selectedModel: MODEL_ID, resolvedModel: MODEL_ID, notices: [],
    partial: true, modelSteps: 1,
  };
  await new Promise((resolve, reject) => {
    const abort = () => {
      // The kill orcode's own tool teardown performs: the whole process
      // group, because the child was spawned into its own.
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { try { process.kill(child.pid, "SIGKILL"); } catch {} }
      runOutcome = "cancelled";
      observer.onEvent?.({
        type: "run-end", timestamp: Date.now(), outcome: "cancelled",
        durationMs: 1, toolCount: 1,
      });
      // Exactly what the real agent does for a cancelled run
      // (agent.ts:1666-1668): it can never resolve.
      reject(new AgentRunError(new Error("cancelled"), "cancelled", partial));
    };
    if (observer.signal?.aborted) { abort(); return; }
    observer.signal?.addEventListener("abort", abort, { once: true });
    if (!observer.signal) resolve(partial);
  });
  return partial;
};

/** The scripted run every "a run streams" pin drives. */
const scriptedRun = async (prompt, observer = {}) => {
  if(scenario==='local-workcopy'){
    const {WorkspaceGuard,ChangeJournal,createCodingTools}=await import(new URL('./workspace.js',guiModuleUrl));
    const tools=createCodingTools(await WorkspaceGuard.create(localAgentWorkspace),approvals,
      new ChangeJournal({appHome,chatId:freshSession.data.id}),{signal:observer.signal});
    await tools.find(item=>item.function.name==='write_file').function.execute({path:'notes.md',content:'local candidate\n'});
  }
  if (scenario === "cancel-on-eof" || scenario === "hanging-balance") {
    return longRun(prompt, observer);
  }
  // A run that fails the way a provider call fails, so the transcript's own
  // error frame can be inspected on the wire.
  if (scenario === "run-error") {
    agentCalls += 1;
    observer.onEvent?.({
      type: "run-start", timestamp: Date.now(), model: MODEL_ID, maxSteps: 7,
      costKnowledge: "known", prompt,
    });
    throw PROVIDER_ERROR;
  }
  agentCalls += 1;
  const now = Date.now();
  observer.onStatus?.("Thinking …");
  observer.onEvent?.({
    type: "run-start", timestamp: now, model: MODEL_ID, maxSteps: 7,
    costKnowledge: "known", prompt,
  });
  observer.onEvent?.({ type: "model-start", timestamp: now, model: MODEL_ID, step: 1 });
  observer.onEvent?.({
    type: "reasoning", timestamp: now, model: MODEL_ID, step: 1,
    delta: "Weighing the options.",
  });
  observer.onEvent?.({
    type: "tool-start", timestamp: now, id: "t1", number: 1, name: "write_file",
    input: { path: "notes.md" },
  });
  observer.onEvent?.({
    type: "process-start", timestamp: now, id: "p1", name: "bash",
    input: { command: "echo hi" }, toolId: "t1", toolNumber: 1,
  });
  // Deliberately torn: the line-boundary hold must reassemble these before a
  // reader ever sees them.
  observer.onEvent?.({
    type: "process-output", timestamp: now, id: "p1", name: "bash",
    input: { command: "echo hi" }, stream: "stdout", text: "first ",
  });
  observer.onEvent?.({
    type: "process-output", timestamp: now, id: "p1", name: "bash",
    input: { command: "echo hi" }, stream: "stdout", text: "half\nsecond line\n",
  });
  observer.onEvent?.({
    type: "file-change", timestamp: now, path: "notes.md", tool: "write_file",
    created: true, added: 1, removed: 0, diff: "+ hello", truncated: false,
  });
  observer.onEvent?.({
    type: "tool-end", timestamp: now, id: "t1", number: 1, name: "write_file",
    input: { path: "notes.md" }, output: "ok", durationMs: 4,
  });
  if (scenario === "approval" && approvals) {
    // The REAL ApprovalManager, with the prompt handler the server installed
    // — so this round trip proves the protocol ask, not a stand-in.
    try {
      await approvals.authorize({
        name: "write_file",
        risk: "medium",
        summary: "Write notes.md",
        details: "1 line added",
      });
      observer.onEvent?.({
        type: "tool-end", timestamp: now, id: "t2", number: 2, name: "write_file",
        input: { path: "notes.md" }, output: "approved", durationMs: 1,
      });
    } catch (error) {
      observer.onEvent?.({
        type: "tool-error", timestamp: now, id: "t2", number: 2, name: "write_file",
        input: { path: "notes.md" }, error: String(error?.message ?? error), durationMs: 1,
      });
    }
  }
  // A bidi override plus a C0 control and an ANSI sequence, in the two
  // places model text reaches a surface: the streamed answer and the run
  // union's own `text` event. In a WebView U+202E survives HTML escaping and
  // reverses what follows it, so a model can display one thing and mean
  // another.
  observer.onText?.("Hello ", "Hello ");
  observer.onText?.("\u202eworld\u0007.\u001b[31m", "Hello world.");
  observer.onEvent?.({
    type: "text", timestamp: now,
    delta: "Hello \u202eworld\u0007.\u001b[31m",
  });
  observer.onEvent?.({
    type: "run-end", timestamp: now, outcome: "complete", durationMs: 9, toolCount: 1,
  });
  return {
    text: "Hello world.",
    suggestions: ["Ask for a diff"],
    outcome: "completed",
    costUsd: 0.002,
    mainCostUsd: 0.002,
    compressorCostUsd: 0,
    costKnowledge: "known",
    compression: { applied: false, warnings: [] },
    selectedModel: MODEL_ID,
    resolvedModel: MODEL_ID,
    notices: [],
    partial: false,
    modelSteps: 1,
  };
};

/** Captured from `createAgent`'s own input — the manager the server wired. */
let approvals = null;

const agent = {
  run: scriptedRun,
  setSession() {},
  resetConversationMemory() {},
  guard: {},
};

let exitCode;
const commandConfigBytesBefore = await readFile(configPath, "utf8").catch(() => null);
const commandSessionBytesBefore = await readFile(freshSession.path, "utf8").catch(() => null);
const commandLiveConfigBefore = JSON.stringify(persisted);
const commandLiveSessionBefore = JSON.stringify(freshSession.data);
process.chdir(workspace);
try {
  exitCode = await gui.runGuiServer({
    argv: [],
    bootstrap: {
      initializeStorage: async () => ({
        appHome,
        configPath,
        migrationWarning: null,
        retentionWarnings: [],
        config: persisted,
        ruleStore: rules,
        session: freshSession,
        startDeferredRetention: () => {},
      }),
      createProviderRuntime: async () => runtime,
      createAgent: async (input) => {
        localAgentWorkspace=input.workspace;
        approvals = input.approvals ?? null;
        return agent;
      },
      environment: { ...process.env, ORCODE_ASCII: "1" },
    },
  });
} finally {
  process.stderr.write(`ORCODE_GUI_RESULT:${JSON.stringify({
    scenario,
    exitCode: exitCode ?? null,
    agentCalls,
    priorChatId: priorChat.data.id,
    foreignChatId: foreignChat.data.id,
    toolChildPid,
    runOutcome,
    saveCalls,
    saveCallsAtRunStart,
    modelTransitions,
    savedMainModel: JSON.parse(await readFile(configPath, "utf8")).mainModel,
    liveMainModel: persisted.mainModel,
    savedDefaultRoute: await readFile(configPath, "utf8").then((value) => {
      const saved = JSON.parse(value).providerSetup?.defaultRoute;
      return saved ? { backendId: saved.backendId, requestedModelId: saved.requestedModelId } : null;
    }).catch(() => null),
    durableSessionRoute: await readFile(freshSession.path, "utf8").then((value) => {
      const saved = JSON.parse(value).route;
      return saved ? { backendId: saved.backendId, requestedModelId: saved.requestedModelId } : null;
    }).catch(() => null),
    liveSessionRoute: freshSession.data.route
      ? { backendId: freshSession.data.route.backendId, requestedModelId: freshSession.data.route.requestedModelId }
      : null,
    liveRuntimeRoute: realModelRuntime?.currentSessionRoute()
      ? {
          backendId: realModelRuntime.currentSessionRoute().backendId,
          requestedModelId: realModelRuntime.currentSessionRoute().requestedModelId,
        }
      : null,
    settingsKimiAdapterActivations,
    modelDurableConfig: scenario === "desktop-deferred-model-command"
      ? JSON.parse(await readFile(configPath, "utf8")).mainModel : null,
    durableCompressorModel: JSON.parse(await readFile(configPath, "utf8")).compressorModel ?? null,
    modelDurableProviderRoute: scenario === "desktop-deferred-model-command"
      ? JSON.parse(await readFile(configPath, "utf8")).providerSetup?.defaultRoute?.requestedModelId ?? null : null,
    modelLiveRuntimeRoute: realModelRuntime?.currentSessionRoute()?.requestedModelId ?? null,
    modelLiveSession: scenario === "desktop-deferred-model-command" ? freshSession.data.model : null,
    modelDurableSession: scenario === "desktop-deferred-model-command"
      ? JSON.parse(await readFile(freshSession.path, "utf8")).model : null,
    modelTransactionJournals: modelTransactionAppHome
      ? await readdir(join(modelTransactionAppHome, "transactions/model-preference")).catch(() => []) : [],
    foreignWorkspace,
    workspace,
    freshSessionId: freshSession.data.id,
    crossModeAfter: freshSession.data.crossMode
      ? { oneShot: freshSession.data.crossMode.oneShot === true }
      : null,
    // Self-reported from the real files this process wrote: the ghost-file
    // guard (D8c / FIX-20 finding 7) is checked against this list, not
    // against internal state.
    chatFileIds: (await CHAT_ARTIFACT_REGISTRY.all("chat", appHome))
      .map((artifact) => artifact.chatId)
      .sort(),
    submittedSecretLength,
    providerCredentialCalls,
    desktopCodexLoginCalls,
    desktopCodexLoginMethod,
    routePickerCaptureCalls,
    atomicRaceInitialMatchingRows,
    atomicRaceEpochChanges,
    desktopDisabledKimiBindingProven,
    desktopRoutePickerViewCalls,
    desktopRoutePickerResolveCalls,
    desktopAuthorityGetterCalls,
    terminalOwnerAuthorityCalls,
    terminalOwnerViewCalls,
    terminalOwnerResolveCalls,
    crossPreferenceReads,
    crossPreferencePublishes,
    sessionArmCalls,
    modelPreferenceAuthorityReads,
    settingsPublicationPrepares,
    settingsPublicationPublishes,
    transitionEntries,
    adoptSessionCalls,
    configMutationCalls,
    settingsMutationTaskCalls,
    settingsMutationHeld,
    settingsTimeoutMutationReleased,
    settingsTimeoutReleaseFrames,
    settingsTimeoutCloseAccepted,
    settingsTimeoutTransportDeferrals,
    settingsTimeoutControllerSettlements,
    startupInspectionStarted,
    startupInspectionReleased,
    genericCredentialCalls,
    credentialMethodCalls,
    sessionPublicationPrepares,
    sessionPublicationPublishes,
    protocolAskFrames,
    protocolTranscriptFrames,
    protocolActivityFrames,
    protocolSettingsClosedFrames,
    settingsDesktopBeginCalls,
    settingsDesktopAdvanceCalls,
    settingsDesktopCancelAdvances,
    settingsDesktopAbortCalls,
    commandConfigBytesStable: await readFile(configPath, "utf8").catch(() => null).then((value) => value === commandConfigBytesBefore),
    commandSessionBytesStable: await readFile(freshSession.path, "utf8").catch(() => null).then((value) => value === commandSessionBytesBefore),
    commandLiveConfigStable: JSON.stringify(persisted) === commandLiveConfigBefore,
    commandLiveSessionStable: JSON.stringify(freshSession.data) === commandLiveSessionBefore,
    ownerKimiRunnableBaseline,
    legacyRouteCatalogCalls,
    desktopSetupCalls,
    desktopNanoSetupCalls,
    desktopNanoBillingMode,
    desktopNanoSelectedModel,
    desktopNanoSecretLength,
    desktopNanoCommitAccepted,
    desktopSetupEntered,
    desktopSetupSettled,
    desktopSetupAborted,
    desktopSetupAbortListenersRemoved,
    desktopRefreshCalls,
    desktopActivationCalls,
    desktopCancelCalls,
    desktopCancelCallsBeforeSetupSettlement,
    desktopSetupProofReconciliations,
    desktopSetupProofAccepted,
    desktopRefreshAborted,
    desktopActiveOperations,
    desktopAbortListenersRemoved,
    desktopActiveDrainTimers: desktopDrainTimers.size,
    desktopDrainTimersCreated,
    desktopDrainTimersCleared,
    desktopKimiDeltas: desktopKimiBaseline ? {
      catalogue: desktopCatalogueCalls - desktopKimiBaseline.catalogue,
      credential: desktopKimiCredentialEffects - desktopKimiBaseline.credential,
      setup: desktopSetupCalls - desktopKimiBaseline.setup,
      refresh: desktopRefreshCalls - desktopKimiBaseline.refresh,
      activation: desktopActivationCalls - desktopKimiBaseline.activation,
      transcript: protocolTranscriptFrames - desktopKimiBaseline.transcript,
      agent: agentCalls - desktopKimiBaseline.agent,
      cost: freshSession.data.costs.totalUsd - desktopKimiBaseline.cost,
      ask: protocolAskFrames - desktopKimiBaseline.ask,
      activity: protocolActivityFrames - desktopKimiBaseline.activity,
    } : null,
    desktopKimiCanaryInjected: desktopKimiEffectCanary !== null,
    desktopRerootCalls,
    desktopChatMutationCalls,
    priorChatByteStable: await readFile(priorChatPath, "utf8").then(
      (value) => value === priorChatBytesBefore,
    ),
    priorChatTurnCountBefore,
    priorChatTurnCountAfter: await readFile(priorChatPath, "utf8").then(
      (value) => JSON.parse(value).turns.length,
    ),
    priorChatTurnBytesStable: await readFile(priorChatPath, "utf8").then(
      (value) => JSON.stringify(JSON.parse(value).turns) === JSON.stringify(priorChatBefore.turns),
    ),
    priorChatRevisionBefore: priorChatBefore.revision,
    priorChatRevisionAfter: await readFile(priorChatPath, "utf8").then(
      (value) => JSON.parse(value).revision,
    ),
    setupSecretLengths,
    sessionCostUsd: freshSession.data.costs.totalUsd,
    crossWorkerPids,
    crossWorkersStarted,
    crossWorkersAborted,
    setupDefaultRoute: setupWorld
      ? setupWorld.stateStore.read().defaultRoute
      : null,
    // Read back off the real file the Settings save wrote, not off memory.
    savedShowLargeLogo: await config
      .loadConfig(configPath)
      .then((saved) => saved.appearance.showLargeLogo)
      .catch(() => null),
    liveShowLargeLogo: persisted.appearance.showLargeLogo,
    savedGlyphMode: await config
      .loadConfig(configPath)
      .then((saved) => saved.appearance.glyphMode)
      .catch(() => null),
  })}\n`);
  await rm(root, { recursive: true, force: true });
}
process.exitCode = exitCode;
