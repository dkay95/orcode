import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { OpenRouter } from "@openrouter/agent";
import { HTTPClient } from "@openrouter/sdk";

import {
  deriveProviderHeadline,
  type BackendAdapter,
  type BackendId,
  type BackendModelDescriptor,
  type BillingRealm,
  type CandidateProviderState,
  type ProviderCandidate,
  type ProviderHealth,
  type ProviderInspection,
  type RouteIdentityV1,
} from "./backends.js";
import {
  CodexAppServerClient,
  createCodexAppServerLaunchPlan,
  resolveOfficialCodexPayload,
} from "./codex-app-server.js";
import { createCodexHome, type CodexProfileRuntime } from "./codex-profile.js";
import { CodexRouteGate, type CodexRouteBinding } from "./codex-route-gate.js";
import { assertCodexAccountFingerprint, codexAccountFingerprint } from "./codex-account-identity.js";
import type { CodexManagedTurnAuthority } from "./codex-managed-turn.js";
import { CodexNativeShellActions } from "./native-shell-action.js";
import type { NativeSidecarChannel } from "./native-sidecar-channel.js";
import type { CrossProviderStage } from "./collaboration.js";
import {
  KIMI_CODE_MODELS,
  KimiCodeRequestError,
  describeKimiCodeFailure,
  type KimiCodeModelId,
} from "./kimi-code.js";
import {
  KimiDesktopPermitRequiredError,
  type KimiCrossRunAuthority,
  type KimiCrossStageRequestAuthority,
} from "./kimi-desktop-permit.js";
import {
  KIMI_CHAT_COMPLETIONS_URL,
  KIMI_RESPONSES_SDK_SENTINEL,
  createKimiResponsesFetcher,
  type KimiBridgeBindingProof,
  type KimiDesktopCrossContext,
  type KimiDesktopTurnContext,
} from "./kimi-responses-bridge.js";
import {
  isDesktopKimiRuntimeCapability,
  type DesktopKimiRuntimeCapability,
  type KimiExecutionOrigin,
} from "./kimi-execution-origin.js";
import type { ProviderCredentialAuthorityLike } from "./provider-authority.js";
import type { CodexRouteActivationSelection, CodexProfileRetentionSelection } from "./provider-activation.js";
import {
  credentialBindingForConnection,
  type ProviderConnectionStateV3,
  type ProviderStateStore,
} from "./provider-state.js";
import type { ConnectionEventListener } from "./reconnect.js";
import type { BalanceInfo, ModelInfo } from "./types.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type RuntimeModelPrice =
  | {
      readonly kind: "known";
      readonly promptUsdPerToken: number;
      readonly completionUsdPerToken: number;
    }
  | { readonly kind: "unknown" };

export interface RuntimeModelInfo {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
  readonly reasoning: ModelInfo["reasoning"];
  readonly price: RuntimeModelPrice;
}

export type RuntimeSpend =
  | { readonly kind: "known"; readonly balance: BalanceInfo }
  | { readonly kind: "unknown" };

export type ModelDispatchFields =
  | {
      readonly backendId: "openrouter";
      readonly models: readonly string[];
      readonly provider: {
        sort?: "price" | "throughput" | "latency";
        dataCollection?: "allow" | "deny";
        only?: string[];
        ignore?: string[];
        allowFallbacks?: boolean;
      };
      readonly plugins?: readonly { readonly id: "web"; readonly maxResults: 5 }[];
    }
  | {
      readonly backendId: "kimi-code";
      readonly model: KimiCodeModelId;
    }
  | {
      readonly backendId: "nano-gpt";
      readonly model: string;
    };

export interface ModelRuntime {
  readonly backendId: Extract<BackendId, "openrouter" | "kimi-code" | "nano-gpt">;
  createClient(request: { readonly route: RouteIdentityV1; readonly scope: "main" | "compressor" }): OpenRouter;
  inspectSpend(signal?: AbortSignal): Promise<RuntimeSpend>;
  listModels(modelId: string, signal?: AbortSignal): Promise<RuntimeModelInfo[]>;
  dispatchFields(request: {
    readonly route: RouteIdentityV1;
    readonly allowWeb: boolean;
  }): ModelDispatchFields;
  onConnectionEvent(listener: ConnectionEventListener): () => void;
  safeMessage(error: unknown): string;
  withKimiTurnContext?<T>(
    context: Readonly<{ sessionId: string; runId: string }>,
    task: () => Promise<T>,
  ): Promise<T>;
  withKimiCrossStageContext?<T>(
    context: Readonly<{
      crossRunId: string;
      stage: CrossProviderStage;
      route: RouteIdentityV1;
      authority: KimiCrossRunAuthority;
      signal: AbortSignal;
    }>,
    task: () => Promise<T>,
  ): Promise<T>;
}

export type KimiRuntimeBindingProof = KimiBridgeBindingProof;

export interface KimiCodeModelRuntimeOptions {
  readonly route: RouteIdentityV1;
  readonly binding: KimiRuntimeBindingProof;
  readonly credentialAuthority: ProviderCredentialAuthorityLike;
  readonly fetch: FetchLike;
  readonly now: () => number;
  /** Required request-policy seam. The runtime deliberately supplies no timeout default. */
  readonly createRequestDeadlineAt: () => number;
  /** Task 4 supplies this closed origin at the live coordinator/call site. */
  readonly executionOrigin?: KimiExecutionOrigin;
  /** Latent internal desktop authority. Task 5 is the sole production minter. */
  readonly desktopKimiCapability?: DesktopKimiRuntimeCapability;
  /** Desktop-only public-context-free correlation; the bridge creates requestId and digest itself. */
  readonly createDesktopTurnContext?: () => KimiDesktopTurnContext;
}

function knownKimiModel(value: string | null): value is KimiCodeModelId {
  return value !== null && KIMI_CODE_MODELS.some((model) => model.id === value);
}

function exactRoute(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return left.version === right.version
    && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.requestedModelId === right.requestedModelId
    && left.canonicalModelId === right.canonicalModelId
    && left.resolutionState === right.resolutionState;
}

function validBinding(route: RouteIdentityV1, proof: KimiRuntimeBindingProof): boolean {
  return proof.version === 1
    && Number.isSafeInteger(proof.stateRevision)
    && proof.stateRevision >= 0
    && Number.isSafeInteger(proof.generation)
    && proof.generation >= 0
    && proof.connectionId.length > 0
    && proof.backendId === "kimi-code"
    && proof.accountFingerprint.length > 0
    && proof.billingRealm === "kimi-code-membership-provider-managed-overage"
    && knownKimiModel(proof.canonicalModelId)
    && route.version === 1
    && route.backendId === proof.backendId
    && route.accountFingerprint === proof.accountFingerprint
    && route.billingRealm === proof.billingRealm
    && route.canonicalModelId === proof.canonicalModelId
    && route.resolutionState === "resolved";
}

function immutableRoute(route: RouteIdentityV1): RouteIdentityV1 {
  return Object.freeze({
    version: route.version,
    backendId: route.backendId,
    accountFingerprint: route.accountFingerprint,
    billingRealm: route.billingRealm,
    requestedModelId: route.requestedModelId,
    canonicalModelId: route.canonicalModelId,
    resolutionState: route.resolutionState,
  });
}

function immutableProof(proof: KimiRuntimeBindingProof): KimiRuntimeBindingProof {
  return Object.freeze({
    version: proof.version,
    stateRevision: proof.stateRevision,
    generation: proof.generation,
    connectionId: proof.connectionId,
    backendId: proof.backendId,
    accountFingerprint: proof.accountFingerprint,
    billingRealm: proof.billingRealm,
    canonicalModelId: proof.canonicalModelId,
  });
}

function kimiModelInfo(model: (typeof KIMI_CODE_MODELS)[number]): RuntimeModelInfo {
  return {
    id: model.id,
    name: model.displayName,
    contextLength: model.effectiveContextDefault,
    reasoning: {
      defaultEffort: "high",
      defaultEnabled: true,
      mandatory: true,
      supportedEfforts: model.reasoningEfforts === null ? null : [...model.reasoningEfforts],
      supportsMaxTokens: false,
    },
    price: { kind: "unknown" },
  };
}

export function createKimiCodeModelRuntime(options: KimiCodeModelRuntimeOptions): ModelRuntime {
  const route = immutableRoute(options.route);
  const binding = immutableProof(options.binding);
  if (!validBinding(route, binding)) {
    throw new Error("Kimi runtime binding is invalid.");
  }
  const desktopCapability = options.desktopKimiCapability;
  if (desktopCapability !== undefined && !isDesktopKimiRuntimeCapability(desktopCapability)) {
    throw new Error("Kimi desktop runtime capability is invalid.");
  }
  if (desktopCapability !== undefined && options.executionOrigin?.kind !== "desktop-native") {
    throw new Error("Kimi desktop runtime capability requires the desktop execution origin.");
  }
  type ActiveTurnContext = Readonly<{
    sessionId: string;
    runId: string;
    identity: object;
    controller: AbortController;
  }>;
  const turnContext = desktopCapability === undefined
    ? null
    : new AsyncLocalStorage<ActiveTurnContext>();
  const activeTurnScopes = desktopCapability === undefined ? null : new Set<object>();
  type ActiveCrossContext = Readonly<{
    crossRunId: string;
    stage: CrossProviderStage;
    route: RouteIdentityV1;
    identity: object;
    controller: AbortController;
    scope: KimiCrossStageRequestAuthority;
  }>;
  const crossContext = desktopCapability === undefined
    ? null
    : new AsyncLocalStorage<ActiveCrossContext>();
  const activeCrossScopes = desktopCapability === undefined ? null : new Set<object>();
  const clients = new Map<"main" | "compressor", OpenRouter>();

  const runtime: ModelRuntime = {
    backendId: "kimi-code",
    createClient(request) {
      if (!exactRoute(request.route, route)) {
        clients.clear();
        throw new Error("Kimi runtime route binding changed.");
      }
      const cached = clients.get(request.scope);
      if (cached) return cached;
      const fetcher = createKimiResponsesFetcher({
        fetch: options.fetch,
        url: KIMI_CHAT_COMPLETIONS_URL,
        now: options.now,
        route,
        binding,
        credentialAuthority: options.credentialAuthority,
        createRequestDeadlineAt: options.createRequestDeadlineAt,
        ...(options.executionOrigin === undefined ? {} : { executionOrigin: options.executionOrigin }),
        ...(desktopCapability === undefined ? {} : { desktopKimiCapability: desktopCapability }),
        ...(desktopCapability !== undefined
          ? {
              createDesktopCrossContext: (): KimiDesktopCrossContext | null => {
                const context = crossContext?.getStore();
                const active = context !== undefined
                  && activeCrossScopes?.has(context.identity) === true
                  && !context.controller.signal.aborted;
                if (!active) return null;
                context.scope.assertCurrent();
                return {
                  crossRunId: context.crossRunId,
                  stage: context.stage,
                  route: context.route,
                  scope: context.scope,
                };
              },
              createDesktopTurnContext: () => {
                const context = turnContext?.getStore();
                const active = context !== undefined
                  && activeTurnScopes?.has(context.identity) === true
                  && !context.controller.signal.aborted;
                if (!active) throw new KimiDesktopPermitRequiredError();
                const scope = Object.freeze({
                  signal: context.controller.signal,
                  assertCurrent(): void {
                    if (activeTurnScopes?.has(context.identity) !== true
                      || context.controller.signal.aborted) {
                      throw new KimiDesktopPermitRequiredError();
                    }
                  },
                });
                return {
                  sessionId: context.sessionId,
                  childPid: desktopCapability.childPid,
                  runId: context.runId,
                  scope,
                };
              },
            }
          : options.createDesktopTurnContext === undefined
            ? {}
            : { createDesktopTurnContext: options.createDesktopTurnContext }),
      });
      const client = new OpenRouter({
        apiKey: KIMI_RESPONSES_SDK_SENTINEL,
        serverURL: "https://orcode-kimi-sdk.invalid",
        httpClient: new HTTPClient({ fetcher }),
        retryConfig: { strategy: "none" },
      });
      clients.set(request.scope, client);
      return client;
    },
    async inspectSpend() {
      return { kind: "unknown" };
    },
    async listModels(search = "") {
      const wanted = search.trim().toLowerCase();
      const exact = KIMI_CODE_MODELS.find((model) => model.id.toLowerCase() === wanted);
      const selected = exact
        ? [exact]
        : KIMI_CODE_MODELS.filter((model) => wanted.length === 0
          || `${model.id} ${model.displayName}`.toLowerCase().includes(wanted));
      return selected.map(kimiModelInfo);
    },
    dispatchFields(request) {
      if (!exactRoute(request.route, route) || !knownKimiModel(route.canonicalModelId)) {
        clients.clear();
        throw new Error("Kimi runtime route binding changed.");
      }
      return { backendId: "kimi-code", model: route.canonicalModelId };
    },
    onConnectionEvent() {
      return () => {};
    },
    safeMessage(error) {
      const failure = describeKimiCodeFailure(error);
      return new KimiCodeRequestError(failure).message;
    },
    ...(turnContext === null
      ? {}
      : {
          async withKimiTurnContext<T>(
            context: Readonly<{ sessionId: string; runId: string }>,
            task: () => Promise<T>,
          ): Promise<T> {
            if (!context
              || typeof context.sessionId !== "string" || context.sessionId.length === 0
              || typeof context.runId !== "string" || context.runId.length === 0
              || typeof task !== "function") {
              throw new Error("Kimi desktop turn context is invalid.");
            }
            const identity = Object.freeze({});
            const controller = new AbortController();
            activeTurnScopes!.add(identity);
            try {
              return await turnContext.run(Object.freeze({
                sessionId: context.sessionId,
                runId: context.runId,
                identity,
                controller,
              }), task);
            } finally {
              activeTurnScopes!.delete(identity);
              controller.abort(new KimiDesktopPermitRequiredError());
            }
          },
          async withKimiCrossStageContext<T>(
            context: Readonly<{
              crossRunId: string;
              stage: CrossProviderStage;
              route: RouteIdentityV1;
              authority: KimiCrossRunAuthority;
              signal: AbortSignal;
            }>,
            task: () => Promise<T>,
          ): Promise<T> {
            if (!context
              || typeof context.crossRunId !== "string" || context.crossRunId.length === 0
              || !exactRoute(context.route, route)
              || !context.authority || typeof context.authority.runStage !== "function"
              || typeof context.authority.revoke !== "function"
              || !context.signal || typeof context.signal.addEventListener !== "function"
              || typeof task !== "function") {
              throw new KimiDesktopPermitRequiredError();
            }
            const identity = Object.freeze({});
            const controller = new AbortController();
            const stageSignal = AbortSignal.any([context.signal, controller.signal]);
            try {
              return await context.authority.runStage({
                crossRunId: context.crossRunId,
                stage: context.stage,
                route,
                signal: stageSignal,
              }, async (scope) => {
                activeCrossScopes!.add(identity);
                try {
                  return await crossContext!.run(Object.freeze({
                    crossRunId: context.crossRunId,
                    stage: context.stage,
                    route,
                    identity,
                    controller,
                    scope,
                  }), task);
                } finally {
                  activeCrossScopes!.delete(identity);
                }
              });
            } finally {
              activeCrossScopes!.delete(identity);
              controller.abort(new KimiDesktopPermitRequiredError());
            }
          },
        }),
  };
  return runtime;
}

export interface CodexAccountModelClient {
  start(signal?: AbortSignal): Promise<void>;
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  onNotification(method: "account/updated" | "account/login/completed", listener: (params: unknown) => void): () => void;
  onTerminal?(listener: () => void): () => void;
  drain(): Promise<"closed" | "killed">;
}

export interface CodexNativeLoginAuthority {
  readonly channel: NativeSidecarChannel;
  /** Native sidecar launch generation, not the profile AppServer generation. */
  readonly childGeneration: number;
}

export interface CodexProfileRouteRuntimeOptions {
  readonly appHome: string;
  readonly stateStore: ProviderStateStore;
  readonly nativeLogin?: CodexNativeLoginAuthority;
  /** Internal constructor seam. Production composition never supplies it. */
  readonly createClient?: (input: Readonly<{
    connection: ProviderConnectionStateV3;
    profile: CodexProfileRuntime;
    signal: AbortSignal;
  }>) => Promise<CodexAccountModelClient>;
}

interface CodexProfileSession {
  readonly connectionId: string;
  readonly accountFingerprint: string;
  readonly billingRealm: Extract<BillingRealm,
    "chatgpt-subscription-provider-managed-overage" | "chatgpt-account-provider-managed-limits">;
  readonly profile: CodexProfileRuntime;
  readonly client: CodexAccountModelClient;
  readonly childGeneration: number;
  authEpoch: number;
  accountEvent: Readonly<{ authMode: "chatgpt"; planType: CodexPlanType }> | null;
  detachAccountUpdated: () => void;
  gate: CodexRouteGate | null;
}

interface CodexProfileCatalog {
  readonly connectionId: string;
  readonly stateRevision: number;
  readonly generation: number;
  readonly childGeneration: number;
  readonly authEpoch: number;
  readonly accountEvent: CodexProfileSession["accountEvent"];
  readonly models: readonly BackendModelDescriptor[];
}

export interface CodexCurrentRouteAuthority {
  readonly client: CodexAccountModelClient;
  readonly gate: CodexRouteGate;
  readonly binding: CodexRouteBinding;
  readonly childGeneration: number;
}

type CodexPlanType =
  | "free" | "go" | "plus" | "pro" | "prolite" | "team"
  | "self_serve_business_usage_based" | "business"
  | "enterprise_cbp_usage_based" | "enterprise" | "edu" | "unknown";

const CODEX_PLAN_TYPES: ReadonlySet<string> = new Set([
  "free", "go", "plus", "pro", "prolite", "team",
  "self_serve_business_usage_based", "business",
  "enterprise_cbp_usage_based", "enterprise", "edu", "unknown",
]);

/**
 * One explicitly selected Codex profile at a time. The class owns only
 * account/model discovery and the Task 3 route gate; turn execution remains
 * unavailable until the later prepared-workspace bridge consumes this owner.
 */
export class CodexProfileRouteRuntime implements BackendAdapter {
  readonly backendId = "codex" as const;
  readonly #appHome: string;
  readonly #stateStore: ProviderStateStore;
  readonly #createClient: NonNullable<CodexProfileRouteRuntimeOptions["createClient"]>;
  readonly #nativeLogin: CodexNativeLoginAuthority | undefined;
  #loginPending = false;
  #executionPending = false;
  #session: CodexProfileSession | null = null;
  #catalog: CodexProfileCatalog | null = null;
  #bound: { readonly route: RouteIdentityV1; readonly authority: CodexCurrentRouteAuthority; readonly stateRevision: number; readonly generation: number } | null = null;
  #stateRevision: number | null = null;
  #generation: number | null = null;
  #nextChildGeneration = 0;
  #selectionEpoch = 0;
  readonly #routeInvalidationListeners = new Set<() => void>();

  constructor(options: CodexProfileRouteRuntimeOptions) {
    this.#appHome = options.appHome;
    this.#stateStore = options.stateStore;
    this.#nativeLogin = options.nativeLogin;
    this.#createClient = options.createClient ?? (async ({ profile, signal }) => {
      const executable = await resolveOfficialCodexPayload();
      const launch = await createCodexAppServerLaunchPlan(profile, executable);
      if (signal.aborted) throw abortReason(signal);
      return new CodexAppServerClient(launch);
    });
  }

  nativeLoginAvailable(): boolean {
    return this.#nativeLogin?.channel.isOpen === true
      && Number.isSafeInteger(this.#nativeLogin.childGeneration)
      && this.#nativeLogin.childGeneration > 0;
  }

  async connectNative(method: "chatgpt" | "chatgptDeviceCode", signal?: AbortSignal): Promise<CodexProfileRetentionSelection> {
    if (!this.nativeLoginAvailable()) throw new Error("Native Codex login is unavailable. Open the signed Desktop app and try again.");
    if (method !== "chatgpt" && method !== "chatgptDeviceCode") throw new Error("Choose a supported Codex login method.");
    if (this.#loginPending) throw new Error("A Codex profile login is already pending.");
    const baseline = this.#stateStore.read();
    if (baseline.connections.some((connection) => connection.backendId === "codex")) {
      throw new Error("Only one ChatGPT profile is supported. Select the retained profile.");
    }
    const transportEnded = new AbortController();
    const attempt = AbortSignal.any([...(signal ? [signal] : []), transportEnded.signal, AbortSignal.timeout(300_000)]);
    throwIfCodexAborted(attempt);
    this.#loginPending = true;
    let client: CodexAccountModelClient | null = null;
    let actions: CodexNativeShellActions | null = null;
    let loginId: string | null = null;
    let epoch = 0;
    let event: CodexProfileSession["accountEvent"] = null;
    const completed = new Map<string, boolean>();
    const detach: Array<() => void> = [];
    let wake: (() => void) | null = null;
    const waitForChange = () => new Promise<void>((resolve, reject) => {
      if (attempt.aborted) { reject(abortReason(attempt)); return; }
      const onAbort = () => { wake = null; reject(abortReason(attempt)); };
      attempt.addEventListener("abort", onAbort, { once: true });
      wake = () => { attempt.removeEventListener("abort", onAbort); wake = null; resolve(); };
    });
    try {
      const profile = await createCodexHome({ appHome: this.#appHome, accountLabel: "Persönliches ChatGPT" });
      const pendingConnection: ProviderConnectionStateV3 = {
        id: randomUUID(), backendId: "codex", enabled: true, maturity: "preview",
        credentialBinding: { kind: "provider-runtime", homeId: profile.binding.homeId },
        accountFingerprint: "pending-native-login", accountFingerprintState: "provisional",
        billingRealm: "chatgpt-account-provider-managed-limits", lastHealth: null,
      };
      client = await this.#createClient({ connection: pendingConnection, profile, signal: attempt });
      detach.push(client.onNotification("account/updated", (value) => {
        epoch++; event = validateCodexAccountEvent(value); wake?.();
      }));
      detach.push(client.onNotification("account/login/completed", (value) => {
        if (!isPlainCodexRecord(value) || !safeCodexText(value.loginId) || typeof value.success !== "boolean") return;
        // Uncorrelated completions and raw provider errors are never public evidence.
        if (completed.size < 16) completed.set(value.loginId, value.success);
        wake?.();
      }));
      await client.start(attempt);
      if (client.onTerminal) detach.push(client.onTerminal(() => {
        transportEnded.abort(new Error("Codex login session ended. Reconnect the ChatGPT profile."));
      }));
      const preLoginEpoch = epoch;
      actions = new CodexNativeShellActions({ appServer: client, ...this.#nativeLogin! });
      loginId = (await actions.beginLogin({ type: method }, attempt)).loginId;
      while (!completed.has(loginId)) await waitForChange();
      if (completed.get(loginId) !== true) throw new Error("Codex login did not complete.");
      while (epoch <= preLoginEpoch || event === null) await waitForChange();
      const verifiedEpoch = epoch;
      const verifiedEvent = event as unknown as NonNullable<CodexProfileSession["accountEvent"]>;
      const account = await client.request<unknown>("account/read", { refreshToken: false }, attempt);
      const plan = validateCodexAccount(account, verifiedEvent.planType);
      const fingerprint = codexAccountFingerprint(profile.binding.homeId, account);
      const assertCurrent = () => {
        throwIfCodexAborted(attempt);
        if (!this.nativeLoginAvailable() || epoch !== verifiedEpoch || event !== verifiedEvent
          || this.#stateStore.read().revision !== baseline.revision) {
          throw new Error("Codex login verification is stale. Reconnect the ChatGPT profile.");
        }
      };
      assertCurrent();
      await client.drain();
      assertCurrent();
      const connection: ProviderConnectionStateV3 = Object.freeze({ ...pendingConnection,
        credentialBinding: Object.freeze({ ...pendingConnection.credentialBinding }),
        accountFingerprint: fingerprint, accountFingerprintState: "verified", billingRealm: billingRealmForPlan(plan) });
      return Object.freeze({ connection, assertCurrent });
    } catch (error) {
      if (loginId && actions) await actions.cancelLogin(loginId, AbortSignal.timeout(2_000)).catch(() => undefined);
      if (attempt.aborted) throw abortReason(attempt);
      throw new Error("Codex login verification is not current. Reconnect the ChatGPT profile.", { cause: error });
    } finally {
      await client?.drain().catch(() => undefined);
      for (const dispose of detach) dispose();
      this.#loginPending = false;
    }
  }

  accountLabel(connectionId: string): string {
    const connections = this.#stateStore.read().connections.filter((connection) => connection.backendId === "codex");
    const index = connections.findIndex((connection) => connection.id === connectionId);
    if (index < 0) throw new Error("Codex profile is unavailable.");
    return connections.length === 1 ? "Persönliches ChatGPT" : `Persönliches ChatGPT ${index + 1}`;
  }

  /** Secretless lifecycle signal for projections; it carries no account data. */
  onRouteInvalidated(listener: () => void): () => void {
    this.#routeInvalidationListeners.add(listener);
    return () => this.#routeInvalidationListeners.delete(listener);
  }

  observeStateEpoch(stateRevision: number, generation: number): void {
    if (!Number.isSafeInteger(stateRevision) || stateRevision < 0
      || !Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("Codex provider generation is invalid.");
    }
    if (this.#stateRevision === null && this.#generation === null) {
      this.#stateRevision = stateRevision;
      this.#generation = generation;
      return;
    }
    if (this.#stateRevision === stateRevision && this.#generation === generation) return;
    this.#stateRevision = stateRevision;
    this.#generation = generation;
    this.#invalidateRouteChoice();
  }

  async listModelsForProfile(input: Readonly<{
    connectionId: string;
    stateRevision: number;
    generation: number;
    signal: AbortSignal;
  }>): Promise<readonly BackendModelDescriptor[]> {
    throwIfCodexAborted(input.signal);
    this.observeStateEpoch(input.stateRevision, input.generation);
    const connection = this.#requireConnection(input.connectionId, input.stateRevision);
    this.#invalidateRouteChoice();
    const session = await this.#sessionFor(connection, input.signal);
    throwIfCodexAborted(input.signal);
    const accountEvent = session.accountEvent;
    const authEpoch = session.authEpoch;
    // Official AppServer does not promise an unsolicited startup auth event.
    // Only a never-observed child may establish initial truth via the real read.
    if (!accountEvent && authEpoch !== 0) throw new Error("Codex authentication is not current.");
    if (!accountEvent && !/^codex-sha256:[0-9a-f]{64}$/.test(connection.accountFingerprint)) {
      throw new Error("Codex account identity is unavailable. Reconnect the ChatGPT profile.");
    }
    const account = await session.client.request<unknown>(
      "account/read",
      { refreshToken: false },
      input.signal,
    );
    this.#assertSessionCurrent(session, authEpoch, accountEvent, input);
    const planType = validateCodexAccount(account, accountEvent?.planType);
    assertCodexAccountFingerprint(connection.accountFingerprint, session.profile.binding.homeId, account);
    if (billingRealmForPlan(planType) !== connection.billingRealm) {
      throw new Error("Codex account plan no longer matches the retained profile.");
    }
    const models = await this.#readAllModels(session, authEpoch, accountEvent, input);
    this.#assertSessionCurrent(session, authEpoch, accountEvent, input);
    const catalog: CodexProfileCatalog = Object.freeze({
      connectionId: connection.id,
      stateRevision: input.stateRevision,
      generation: input.generation,
      childGeneration: session.childGeneration,
      authEpoch,
      accountEvent,
      models: Object.freeze(models.map((model) => Object.freeze({
        ...model,
        capabilities: Object.freeze({ ...model.capabilities }),
      }))),
    });
    this.#catalog = catalog;
    return cloneCodexModels(catalog.models);
  }

  currentCatalog(input: Readonly<{
    connectionId: string;
    stateRevision: number;
    generation: number;
  }>): readonly BackendModelDescriptor[] {
    const catalog = this.#catalog;
    const session = this.#session;
    if (!catalog || !session
      || catalog.connectionId !== input.connectionId
      || catalog.stateRevision !== input.stateRevision
      || catalog.generation !== input.generation
      || catalog.childGeneration !== session.childGeneration
      || catalog.authEpoch !== session.authEpoch
      || catalog.accountEvent !== session.accountEvent) return [];
    return cloneCodexModels(catalog.models);
  }

  prepareRouteSelection(input: Readonly<{
    connectionId: string;
    requestedModelId: string;
    canonicalModelId: string;
    stateRevision: number;
    generation: number;
  }>): CodexRouteActivationSelection {
    const connection = this.#requireConnection(input.connectionId, input.stateRevision);
    const catalog = this.#catalog;
    const session = this.#session;
    if (!catalog || !session
      || catalog.connectionId !== connection.id
      || catalog.stateRevision !== input.stateRevision
      || catalog.generation !== input.generation
      || catalog.childGeneration !== session.childGeneration
      || catalog.authEpoch !== session.authEpoch
      || catalog.accountEvent !== session.accountEvent) {
      throw new Error("Codex profile model selection is stale.");
    }
    const matches = catalog.models.filter((model) =>
      model.requestedModelId === input.requestedModelId
      && model.canonicalModelId === input.canonicalModelId
    );
    if (matches.length !== 1) throw new Error("Codex profile model selection is unavailable.");
    const route: RouteIdentityV1 = Object.freeze({
      version: 1,
      backendId: "codex",
      accountFingerprint: connection.accountFingerprint,
      billingRealm: connection.billingRealm,
      requestedModelId: input.requestedModelId,
      canonicalModelId: input.canonicalModelId,
      resolutionState: "resolved",
    });
    const selectionEpoch = this.#selectionEpoch;
    let bound = false;
    const assertCurrent = () => {
      if (bound || this.#selectionEpoch !== selectionEpoch
        || this.#catalog !== catalog || this.#session !== session
        || this.#stateRevision !== input.stateRevision || this.#generation !== input.generation
        || session.authEpoch !== catalog.authEpoch || session.accountEvent !== catalog.accountEvent) {
        throw new Error("Codex profile model selection is stale.");
      }
      const current = this.#requireConnection(input.connectionId, input.stateRevision);
      if (current.accountFingerprint !== route.accountFingerprint
        || current.billingRealm !== route.billingRealm) {
        throw new Error("Codex profile model selection is stale.");
      }
    };
    return Object.freeze({
      connectionId: connection.id,
      route,
      assertCurrent,
      bind: ({ stateRevision, generation }: Readonly<{ stateRevision: number; generation: number }>) => {
        if (bound || this.#selectionEpoch !== selectionEpoch
          || this.#catalog !== catalog || this.#session !== session
          || session.authEpoch !== catalog.authEpoch || session.accountEvent !== catalog.accountEvent) {
          throw new Error("Codex profile model selection is stale.");
        }
        const currentConnection = this.#requireConnection(input.connectionId, stateRevision);
        if (currentConnection.accountFingerprint !== route.accountFingerprint
          || currentConnection.billingRealm !== route.billingRealm) {
          throw new Error("Codex profile model selection is stale.");
        }
        const current = this.#stateStore.read();
        if (current.revision !== stateRevision || current.defaultRoute === null
          || !exactRoute(current.defaultRoute, route)) {
          throw new Error("Codex route readback is stale.");
        }
        const event = session.accountEvent;
        if (!event && session.authEpoch !== 0) throw new Error("Codex authentication is not current.");
        const binding: CodexRouteBinding = Object.freeze({
          profileId: session.profile.binding.homeId,
          codexHomeRealpath: session.profile.codexHome,
          route,
          modelId: route.canonicalModelId!,
        });
        session.gate?.revoke();
        const gate = new CodexRouteGate({
          client: session.client,
          childGeneration: session.childGeneration,
          ...binding,
        });
        gate.observeModelCatalog(catalog.models.map((model) => model.canonicalModelId));
        if (event) gate.observeAccountUpdated({ childGeneration: session.childGeneration, params: event });
        session.gate = gate;
        this.#stateRevision = stateRevision;
        this.#generation = generation;
        this.#catalog = Object.freeze({ ...catalog, stateRevision, generation });
        this.#bound = Object.freeze({
          route,
          stateRevision,
          generation,
          authority: Object.freeze({
            client: session.client,
            gate,
            binding,
            childGeneration: session.childGeneration,
          }),
        });
        bound = true;
      },
    });
  }

  hasCurrentRoute(route: RouteIdentityV1, stateRevision: number, generation: number): boolean {
    const bound = this.#bound;
    return Boolean(bound
      && bound.stateRevision === stateRevision
      && bound.generation === generation
      && exactRoute(bound.route, route));
  }

  currentRouteAuthority(route: RouteIdentityV1): CodexCurrentRouteAuthority {
    const bound = this.#bound;
    if (!bound || !exactRoute(bound.route, route)) throw new Error("Codex route authority is unavailable.");
    return bound.authority;
  }

  /** A managed turn consumes/drains its client; renew only the same explicit route. */
  async currentExecutionAuthority(route: RouteIdentityV1, signal?: AbortSignal): Promise<CodexManagedTurnAuthority | null> {
    if (signal) throwIfCodexAborted(signal);
    const bound = this.#bound;
    const state = this.#stateStore.read();
    if (!bound || !exactRoute(bound.route, route) || bound.stateRevision !== state.revision
      || bound.generation !== this.#generation || !state.defaultRoute || !exactRoute(state.defaultRoute, route)) return null;
    if (this.#executionPending) throw new Error("Codex execution authority is already being refreshed.");
    const matches = state.connections.filter((connection) => connection.backendId === "codex"
      && connection.accountFingerprint === route.accountFingerprint && connection.billingRealm === route.billingRealm);
    if (matches.length !== 1 || route.canonicalModelId === null) throw new Error("Codex profile selection is unavailable.");
    this.#executionPending = true;
    const input = { connectionId: matches[0]!.id, stateRevision: bound.stateRevision,
      generation: bound.generation, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)]) };
    try {
      await this.#closeSession();
      await this.listModelsForProfile(input);
      if (!(this.#session?.client instanceof CodexAppServerClient)) {
        throw new Error("A concrete official Codex client is required for execution.");
      }
      const selection = this.prepareRouteSelection({ ...input,
        requestedModelId: route.requestedModelId, canonicalModelId: route.canonicalModelId });
      selection.assertCurrent();
      // This is not a preference write: the user's exact durable selection is unchanged.
      selection.bind({ stateRevision: bound.stateRevision, generation: bound.generation });
      const authority = this.currentRouteAuthority(route);
      return Object.freeze({ ...authority, client: this.#session.client });
    } catch (error) {
      await this.#closeSession();
      for (const listener of this.#routeInvalidationListeners) listener();
      throw error;
    } finally {
      this.#executionPending = false;
    }
  }

  async inspect(request: Parameters<BackendAdapter["inspect"]>[0]): Promise<ProviderInspection> {
    const state = this.#stateStore.read();
    const connection = state.connections.find((candidate) => candidate.id === request.connectionId);
    if (!connection || connection.backendId !== "codex") throw new Error("Codex profile is unavailable.");
    const routeEligible = this.#bound?.stateRevision === state.revision
      && this.#bound.generation === request.generation;
    const health: ProviderHealth = routeEligible
      ? {
          credential: "valid", connectivity: "connected", spend: "available",
          runtime: "ready", observedAt: Date.now(), generation: request.generation,
        }
      : {
          credential: "unknown", connectivity: "unknown", spend: "unknown",
          runtime: "ready", observedAt: Date.now(), generation: request.generation,
        };
    return {
      backendId: "codex",
      connectionId: connection.id,
      health,
      headline: deriveProviderHeadline(health),
      accountFingerprint: connection.accountFingerprint,
      billingRealm: connection.billingRealm,
      routeEligible,
      retryable: true,
      explanationCode: routeEligible ? "codex-route-ready" : "codex-explicit-selection-required",
    };
  }

  async reconnect(request: Parameters<BackendAdapter["reconnect"]>[0]): Promise<ProviderInspection> {
    return this.inspect(request);
  }

  async listModels(request: Parameters<BackendAdapter["listModels"]>[0]): Promise<readonly BackendModelDescriptor[]> {
    if (!request.connectionId || this.#stateRevision === null || this.#generation === null) {
      throw new Error("Codex profile selection is required.");
    }
    return this.listModelsForProfile({
      connectionId: request.connectionId,
      stateRevision: this.#stateRevision,
      generation: this.#generation,
      signal: request.signal,
    });
  }

  async connect(): Promise<ProviderCandidate> {
    throw new Error("Codex login invocation is unavailable in this release slice.");
  }

  async activate(): Promise<CandidateProviderState> {
    throw new Error("Codex routes require explicit retained-profile activation.");
  }

  async logout(): Promise<void> {
    throw new Error("Codex logout invocation is unavailable in this release slice.");
  }

  async discardCandidate(): Promise<void> {}

  async #sessionFor(
    connection: ProviderConnectionStateV3,
    signal: AbortSignal,
  ): Promise<CodexProfileSession> {
    const binding = credentialBindingForConnection(connection);
    if (binding.kind !== "provider-runtime") throw new Error("Codex profile binding is invalid.");
    if (this.#session
      && this.#session.connectionId === connection.id
      && this.#session.profile.binding.homeId === binding.homeId
      && this.#session.accountFingerprint === connection.accountFingerprint
      && this.#session.billingRealm === connection.billingRealm
      && (!(this.#session.client instanceof CodexAppServerClient) || this.#session.client.isReady)) return this.#session;
    await this.#closeSession();
    throwIfCodexAborted(signal);
    const profile = await createCodexHome({
      appHome: this.#appHome,
      homeId: binding.homeId,
      accountLabel: this.accountLabel(connection.id),
    });
    throwIfCodexAborted(signal);
    const client = await this.#createClient({ connection: structuredClone(connection), profile, signal });
    const session: CodexProfileSession = {
      connectionId: connection.id,
      accountFingerprint: connection.accountFingerprint,
      billingRealm: connection.billingRealm as CodexProfileSession["billingRealm"],
      profile,
      client,
      childGeneration: ++this.#nextChildGeneration,
      authEpoch: 0,
      accountEvent: null,
      detachAccountUpdated: () => {},
      gate: null,
    };
    this.#session = session;
    session.detachAccountUpdated = client.onNotification("account/updated", (value) => {
      if (this.#session !== session) return;
      const previouslyObserved = session.authEpoch > 0 || this.#bound !== null;
      session.authEpoch += 1;
      session.accountEvent = validateCodexAccountEvent(value);
      this.#invalidateRouteChoice();
      // Startup's first observation initializes a fresh child. Later changes revoke consent.
      if (previouslyObserved) for (const listener of this.#routeInvalidationListeners) listener();
    });
    try {
      await client.start(signal);
      throwIfCodexAborted(signal);
      if (this.#session !== session) throw new Error("Codex profile session is stale.");
      return session;
    } catch (error) {
      if (this.#session === session) this.#session = null;
      session.detachAccountUpdated();
      await client.drain().catch(() => undefined);
      throw error;
    }
  }

  async #readAllModels(
    session: CodexProfileSession,
    authEpoch: number,
    accountEvent: CodexProfileSession["accountEvent"],
    input: Readonly<{ connectionId: string; stateRevision: number; generation: number; signal: AbortSignal }>,
  ): Promise<BackendModelDescriptor[]> {
    const models: BackendModelDescriptor[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await session.client.request<unknown>("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      }, input.signal);
      this.#assertSessionCurrent(session, authEpoch, accountEvent, input);
      const parsed = validateCodexModelPage(response);
      for (const model of parsed.models) {
        if (!models.some((candidate) => candidate.requestedModelId === model.requestedModelId
          && candidate.canonicalModelId === model.canonicalModelId)) models.push(model);
      }
      if (parsed.nextCursor === null) return models;
      if (cursors.has(parsed.nextCursor)) throw new Error("Codex model pagination is invalid.");
      cursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    throw new Error("Codex model pagination exceeded its bound.");
  }

  #assertSessionCurrent(
    session: CodexProfileSession,
    authEpoch: number,
    accountEvent: CodexProfileSession["accountEvent"],
    input: Readonly<{ connectionId: string; stateRevision: number; generation: number; signal: AbortSignal }>,
  ): void {
    throwIfCodexAborted(input.signal);
    if (this.#session !== session || session.authEpoch !== authEpoch
      || session.accountEvent !== accountEvent || this.#stateRevision !== input.stateRevision
      || this.#generation !== input.generation) {
      throw new Error("Codex profile generation is stale.");
    }
    this.#requireConnection(input.connectionId, input.stateRevision);
  }

  #requireConnection(connectionId: string, stateRevision: number): ProviderConnectionStateV3 {
    const state = this.#stateStore.read();
    const connection = state.connections.find((candidate) => candidate.id === connectionId);
    if (state.revision !== stateRevision || !connection || !connection.enabled
      || connection.backendId !== "codex" || connection.maturity !== "preview"
      || connection.accountFingerprintState !== "verified"
      || credentialBindingForConnection(connection).kind !== "provider-runtime"
      || (connection.billingRealm !== "chatgpt-subscription-provider-managed-overage"
        && connection.billingRealm !== "chatgpt-account-provider-managed-limits")) {
      throw new Error("Codex profile connection is unavailable.");
    }
    return connection;
  }

  #invalidateRouteChoice(): void {
    this.#selectionEpoch += 1;
    this.#catalog = null;
    this.#bound = null;
    this.#session?.gate?.revoke();
  }

  async #closeSession(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    this.#invalidateRouteChoice();
    if (!session) return;
    session.detachAccountUpdated();
    session.gate?.revoke();
    await session.client.drain().catch(() => undefined);
  }
}

function validateCodexAccountEvent(value: unknown): CodexProfileSession["accountEvent"] {
  if (!isPlainCodexRecord(value) || !hasExactCodexKeys(value, ["authMode", "planType"])
    || value.authMode !== "chatgpt" || !isCodexPlanType(value.planType)) return null;
  return Object.freeze({ authMode: "chatgpt", planType: value.planType });
}

function validateCodexAccount(value: unknown, expectedPlan?: CodexPlanType): CodexPlanType {
  if (!isPlainCodexRecord(value) || !hasAllowedCodexKeys(value, ["account", "requiresOpenaiAuth"], ["workspaceRouting"])
    || (Object.hasOwn(value, "workspaceRouting") && value.workspaceRouting !== null)
    || value.requiresOpenaiAuth !== true || !isPlainCodexRecord(value.account)
    || !hasExactCodexKeys(value.account, ["type", "email", "planType"])
    || value.account.type !== "chatgpt" || !isCodexPlanType(value.account.planType)
    || (expectedPlan !== undefined && value.account.planType !== expectedPlan)
    || (value.account.email !== null && typeof value.account.email !== "string")) {
    throw new Error("Codex account authentication is not eligible.");
  }
  return value.account.planType;
}

function billingRealmForPlan(plan: CodexPlanType): CodexProfileSession["billingRealm"] {
  return plan === "free" || plan === "unknown"
    ? "chatgpt-account-provider-managed-limits"
    : "chatgpt-subscription-provider-managed-overage";
}

function validateCodexModelPage(value: unknown): {
  readonly models: readonly BackendModelDescriptor[];
  readonly nextCursor: string | null;
} {
  if (!isPlainCodexRecord(value)
    || !hasAllowedCodexKeys(value, ["data"], ["nextCursor"])
    || !Array.isArray(value.data)
    || (value.nextCursor !== undefined && value.nextCursor !== null && !safeCodexText(value.nextCursor))) {
    throw new Error("Codex model response is invalid.");
  }
  const models = value.data.flatMap((candidate): BackendModelDescriptor[] => {
    const model = validateCodexModel(candidate);
    return model ? [model] : [];
  });
  return { models, nextCursor: value.nextCursor ?? null };
}

function validateCodexModel(value: unknown): BackendModelDescriptor | null {
  const required = [
    "defaultReasoningEffort", "description", "displayName", "hidden", "id",
    "isDefault", "model", "supportedReasoningEfforts",
  ];
  const optional = [
    "additionalSpeedTiers", "availabilityNux", "defaultServiceTier", "inputModalities",
    "serviceTiers", "supportsPersonality", "upgrade", "upgradeInfo",
    "modelSpecialty", "multiAgentVersion", "availableAccessPrograms",
  ];
  if (!isPlainCodexRecord(value) || !hasAllowedCodexKeys(value, required, optional)
    || !safeCodexText(value.id) || !safeCodexText(value.model)
    || !safeCodexText(value.displayName) || typeof value.description !== "string"
    || typeof value.hidden !== "boolean" || typeof value.isDefault !== "boolean"
    || !safeCodexText(value.defaultReasoningEffort)
    || !Array.isArray(value.supportedReasoningEfforts)
    || !value.supportedReasoningEfforts.every((effort) => isPlainCodexRecord(effort)
      && hasExactCodexKeys(effort, ["description", "reasoningEffort"])
      && typeof effort.description === "string" && safeCodexText(effort.reasoningEffort))
    || !validOptionalCodexModelFields(value)) {
    throw new Error("Codex model response is invalid.");
  }
  if (value.hidden) return null;
  const modalities = value.inputModalities === undefined ? ["text", "image"] : value.inputModalities;
  return {
    backendId: "codex",
    requestedModelId: value.id,
    canonicalModelId: value.model,
    displayName: value.displayName,
    capabilities: {
      textInput: modalities.includes("text"),
      textOutput: true,
      tools: true,
      reasoning: value.supportedReasoningEfforts.length > 0,
    },
  };
}

function validOptionalCodexModelFields(value: Record<string, unknown>): value is Record<string, unknown> & { inputModalities?: ("text" | "image")[] } {
  const stringArray = (candidate: unknown) => Array.isArray(candidate) && candidate.every((item) => typeof item === "string");
  const modalities = value.inputModalities === undefined
    || (Array.isArray(value.inputModalities)
      && value.inputModalities.every((item) => item === "text" || item === "image")
      && new Set(value.inputModalities).size === value.inputModalities.length);
  const nux = value.availabilityNux === undefined || value.availabilityNux === null
    || (isPlainCodexRecord(value.availabilityNux)
      && hasExactCodexKeys(value.availabilityNux, ["message"])
      && typeof value.availabilityNux.message === "string");
  const tiers = value.serviceTiers === undefined || (Array.isArray(value.serviceTiers)
    && value.serviceTiers.every((tier) => isPlainCodexRecord(tier)
      && hasExactCodexKeys(tier, ["description", "id", "name"])
      && typeof tier.description === "string" && safeCodexText(tier.id) && safeCodexText(tier.name)));
  const rawUpgradeInfo = value.upgradeInfo;
  const programs = value.availableAccessPrograms;
  const accessPrograms = programs === undefined || programs === null
    || (isPlainCodexRecord(programs) && hasExactCodexKeys(programs, ["cyber"])
      && Array.isArray(programs.cyber) && programs.cyber.length <= 3
      && new Set(programs.cyber).size === programs.cyber.length
      && programs.cyber.every((entry) => entry === "standard" || entry === "daybreakBlue" || entry === "daybreakRed"));
  const upgradeInfo = rawUpgradeInfo === undefined || rawUpgradeInfo === null
    || (isPlainCodexRecord(rawUpgradeInfo)
      && hasAllowedCodexKeys(rawUpgradeInfo, ["model"], ["migrationMarkdown", "modelLink", "upgradeCopy"])
      && safeCodexText(rawUpgradeInfo.model)
      && ["migrationMarkdown", "modelLink", "upgradeCopy"].every((key) =>
        rawUpgradeInfo[key] === undefined || rawUpgradeInfo[key] === null
        || typeof rawUpgradeInfo[key] === "string"));
  return modalities && nux && tiers && upgradeInfo && accessPrograms
    && (value.modelSpecialty === undefined || value.modelSpecialty === null || safeCodexText(value.modelSpecialty))
    && (value.multiAgentVersion === undefined || value.multiAgentVersion === null
      || ["disabled", "v1", "v2"].includes(value.multiAgentVersion as string))
    && (value.additionalSpeedTiers === undefined || stringArray(value.additionalSpeedTiers))
    && (value.defaultServiceTier === undefined || value.defaultServiceTier === null || safeCodexText(value.defaultServiceTier))
    && (value.supportsPersonality === undefined || typeof value.supportsPersonality === "boolean")
    && (value.upgrade === undefined || value.upgrade === null || typeof value.upgrade === "string");
}

function cloneCodexModels(models: readonly BackendModelDescriptor[]): BackendModelDescriptor[] {
  return models.map((model) => ({ ...model, capabilities: { ...model.capabilities } }));
}

function isCodexPlanType(value: unknown): value is CodexPlanType {
  return typeof value === "string" && CODEX_PLAN_TYPES.has(value);
}

function safeCodexText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isPlainCodexRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactCodexKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return hasAllowedCodexKeys(value, expected, []);
}

function hasAllowedCodexKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function throwIfCodexAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
