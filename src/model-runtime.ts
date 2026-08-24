import { OpenRouter } from "@openrouter/agent";
import { HTTPClient } from "@openrouter/sdk";

import type { BackendId, RouteIdentityV1 } from "./backends.js";
import {
  KIMI_CODE_MODELS,
  KimiCodeRequestError,
  describeKimiCodeFailure,
  type KimiCodeModelId,
} from "./kimi-code.js";
import {
  KIMI_CHAT_COMPLETIONS_URL,
  KIMI_RESPONSES_SDK_SENTINEL,
  createKimiResponsesFetcher,
  type KimiBridgeBindingProof,
} from "./kimi-responses-bridge.js";
import type { ProviderCredentialAuthorityLike } from "./provider-authority.js";
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
    };

export interface ModelRuntime {
  readonly backendId: Extract<BackendId, "openrouter" | "kimi-code">;
  createClient(request: { readonly route: RouteIdentityV1; readonly scope: "main" | "compressor" }): OpenRouter;
  inspectSpend(signal?: AbortSignal): Promise<RuntimeSpend>;
  listModels(modelId: string, signal?: AbortSignal): Promise<RuntimeModelInfo[]>;
  dispatchFields(request: {
    readonly route: RouteIdentityV1;
    readonly allowWeb: boolean;
  }): ModelDispatchFields;
  onConnectionEvent(listener: ConnectionEventListener): () => void;
  safeMessage(error: unknown): string;
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
      });
      const client = new OpenRouter({
        apiKey: KIMI_RESPONSES_SDK_SENTINEL,
        serverURL: "https://orcode-kimi-sdk.invalid",
        httpClient: new HTTPClient({ fetcher }),
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
  };
  return runtime;
}
