import { createHmac, randomUUID } from "node:crypto";
import {
  deriveProviderHeadline,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendModelDescriptor,
  type CandidateProviderState,
  type ProviderCandidate,
  type ProviderHealth,
} from "./backends.js";
import {
  normalizeProviderSecret,
  type CredentialKind,
  type CredentialSlotRef,
  type VersionedCredentialStoreLike,
} from "./credentials.js";
import {
  OpenRouterHttpError,
  OpenRouterService,
  describeOpenRouterFailure,
  isMainModelCandidate,
  modelCapabilities,
  type BalanceReport,
} from "./openrouter.js";
import type { CreditInfo, KeyInfo } from "./types.js";

export const OPENROUTER_DESCRIPTOR: BackendDescriptor = Object.freeze({
  id: "openrouter",
  displayName: "OpenRouter",
  maturity: "stable",
  connectable: true,
  kind: "raw-model",
  credentialOwner: "orcode-keychain",
  billingRealmKind: "api-payg",
  capabilities: Object.freeze({ models: true, tools: true, reasoning: true }),
});

/** Catalog data only. Slice 1 deliberately has no Anthropic adapter. */
export const ANTHROPIC_COMING_SOON_DESCRIPTOR: BackendDescriptor = Object.freeze({
  id: "anthropic",
  displayName: "Anthropic / Claude-Abo",
  maturity: "coming-soon",
  connectable: false,
  kind: "managed-agent",
  credentialOwner: "none",
  billingRealmKind: "none",
  capabilities: Object.freeze({ models: false, tools: false, reasoning: false }),
});

export interface OpenRouterInspection {
  backendId: "openrouter";
  connectionId: string;
  health: ProviderHealth;
  headline: ReturnType<typeof deriveProviderHeadline>;
  accountFingerprint: string | null;
  billingRealm: "openrouter-payg";
  routeEligible: boolean;
  retryable: boolean;
  explanationCode: string;
  qualifiers: readonly string[];
}

type LegacyCredentialRef = "legacy:inference" | "legacy:management";
type CredentialRef = CredentialSlotRef | LegacyCredentialRef;

export interface OpenRouterBackendAdapterOptions {
  service: OpenRouterService;
  credentials: VersionedCredentialStoreLike;
  connectionId: string;
  inferenceCredential?: CredentialRef;
  managementCredential?: CredentialRef;
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  createCandidateId?: () => string;
}

interface InspectedSecret {
  secret: string;
  balance: BalanceReport;
  inspection: OpenRouterInspection;
}

interface CandidateEntry extends InspectedSecret {
  candidateId: string;
}

type SelectedCredential =
  | { kind: "available"; secret: string }
  | { kind: "absent" }
  | { kind: "invalid" };

export function openRouterAccountFingerprint(
  hmacKey: Uint8Array,
  creatorUserId: string,
): string {
  if (hmacKey.byteLength !== 32 || creatorUserId.length === 0) {
    throw new Error("OpenRouter account identity cannot be fingerprinted safely.");
  }
  const digest = createHmac("sha256", hmacKey)
    .update("orcode-provider-account/v1\0openrouter\0", "utf8")
    .update(creatorUserId, "utf8")
    .digest("base64url");
  return `acct_or_${digest}`;
}

export class OpenRouterBackendAdapter implements BackendAdapter {
  readonly backendId = "openrouter" as const;
  readonly #service: OpenRouterService;
  readonly #credentials: VersionedCredentialStoreLike;
  readonly #connectionId: string;
  readonly #inferenceCredential: CredentialRef;
  readonly #managementCredential: CredentialRef;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #now: () => number;
  readonly #createCandidateId: () => string;
  readonly #candidates = new Map<string, CandidateEntry>();
  #activeInspection: InspectedSecret | null = null;
  #inspectionSequence = 0;

  constructor(options: OpenRouterBackendAdapterOptions) {
    this.#service = options.service;
    this.#credentials = options.credentials;
    this.#connectionId = options.connectionId;
    this.#inferenceCredential = options.inferenceCredential ?? "legacy:inference";
    this.#managementCredential = options.managementCredential ?? "legacy:management";
    this.#environment = options.environment ?? process.env;
    this.#now = options.now ?? Date.now;
    this.#createCandidateId = options.createCandidateId ?? randomUUID;
  }

  async inspect(request: {
    generation: number;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<OpenRouterInspection> {
    void request.deadlineAt;
    const inspectionSequence = ++this.#inspectionSequence;
    this.#activeInspection = null;
    const selected = await this.#selectCredential(
      "inference",
      this.#inferenceCredential,
      "OPENROUTER_API_KEY",
    );
    if (selected.kind !== "available") {
      return this.#emptyInspection(
        request.generation,
        selected.kind === "invalid"
          ? "openrouter-credential-unavailable"
          : "openrouter-credential-missing",
      );
    }
    const inspected = await this.#inspectSecret(
      selected.secret,
      request.generation,
      request.signal,
    );
    if (inspectionSequence === this.#inspectionSequence) {
      this.#activeInspection = inspected.inspection.routeEligible ? inspected : null;
    }
    return inspected.inspection;
  }

  async connect(request: {
    candidate: unknown;
    generation: number;
    signal: AbortSignal;
  }): Promise<ProviderCandidate> {
    if (typeof request.candidate !== "string") {
      throw new Error("OpenRouter candidate input is invalid.");
    }
    const secret = normalizeProviderSecret(request.candidate);
    const inspected = await this.#inspectSecret(
      secret,
      request.generation,
      request.signal,
    );
    const candidateId = this.#createCandidateId();
    if (inspected.inspection.routeEligible) {
      this.#candidates.set(candidateId, { ...inspected, candidateId });
    }
    return {
      candidateId,
      backendId: "openrouter",
      connectionId: this.#connectionId,
      accountFingerprint: inspected.inspection.accountFingerprint,
      billingRealm: "openrouter-payg",
      health: inspected.inspection.health,
    };
  }

  async listModels(request: {
    candidateId?: string;
    signal: AbortSignal;
  }): Promise<readonly BackendModelDescriptor[]> {
    const inspected = request.candidateId
      ? this.#candidates.get(request.candidateId) ?? null
      : this.#activeInspection;
    if (!inspected?.inspection.routeEligible) {
      throw new Error("OpenRouter account inspection must succeed before model listing.");
    }
    const models = await this.#service.inspectModels(request.signal);
    return models
      .filter(isMainModelCandidate)
      .map((model) => {
        const capabilities = modelCapabilities(model);
        return {
          backendId: "openrouter" as const,
          requestedModelId: model.id,
          canonicalModelId: model.canonicalSlug ?? model.id,
          displayName: model.name,
          capabilities: {
            textInput: model.inputModalities.includes("text"),
            textOutput: model.outputModalities.includes("text"),
            tools: capabilities.tools,
            reasoning: capabilities.reasoning,
          },
        };
      });
  }

  async activate(request: {
    candidateId: string;
    model: BackendModelDescriptor;
    signal: AbortSignal;
  }): Promise<CandidateProviderState> {
    throwIfAborted(request.signal);
    const candidate = this.#candidates.get(request.candidateId);
    if (!candidate?.inspection.accountFingerprint) {
      throw new Error("OpenRouter candidate is unavailable or no longer valid.");
    }
    if (
      request.model.backendId !== "openrouter"
      || request.model.requestedModelId.length === 0
      || request.model.canonicalModelId.length === 0
    ) {
      throw new Error("OpenRouter model selection is invalid.");
    }
    this.#service.activateValidatedKey(candidate.secret, "interactive", candidate.balance);
    this.#activeInspection = candidate;
    return {
      candidateId: request.candidateId,
      backendId: "openrouter",
      connectionId: this.#connectionId,
      accountFingerprint: candidate.inspection.accountFingerprint,
      billingRealm: "openrouter-payg",
      route: {
        version: 1,
        backendId: "openrouter",
        accountFingerprint: candidate.inspection.accountFingerprint,
        billingRealm: "openrouter-payg",
        requestedModelId: request.model.requestedModelId,
        canonicalModelId: request.model.canonicalModelId,
        resolutionState: "resolved",
      },
    };
  }

  reconnect(request: {
    generation: number;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<OpenRouterInspection> {
    return this.inspect(request);
  }

  async logout(request: { signal: AbortSignal }): Promise<void> {
    throwIfAborted(request.signal);
    this.#activeInspection = null;
    this.#service.forgetKey();
    this.#service.forgetManagementKey();
  }

  async discardCandidate(candidateId: string): Promise<void> {
    this.#candidates.delete(candidateId);
  }

  async #inspectSecret(
    secret: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<InspectedSecret> {
    let key: KeyInfo;
    try {
      key = await this.#service.inspectKey(secret, signal);
    } catch (error) {
      return {
        secret,
        balance: { key: {} },
        inspection: this.#inspectionFromKeyFailure(error, generation),
      };
    }

    const expiry = credentialFromExpiry(key.expiresAt, this.#now());
    let credits: CreditInfo | undefined;
    let creditsAttempted = false;
    let creditsFailed = false;

    if (key.isManagementKey === true) {
      creditsAttempted = true;
      try {
        credits = await this.#service.getCredits(secret, signal, "candidate");
      } catch {
        throwIfAborted(signal);
        creditsFailed = true;
      }
    } else if (key.isManagementKey === false) {
      const management = await this.#selectCredential(
        "management",
        this.#managementCredential,
        "OPENROUTER_MANAGEMENT_KEY",
      );
      if (management.kind === "available") {
        creditsAttempted = true;
        try {
          credits = await this.#service.getCredits(
            management.secret,
            signal,
            "candidate",
          );
        } catch {
          throwIfAborted(signal);
          creditsFailed = true;
        }
      } else if (management.kind === "invalid") {
        creditsFailed = true;
      }
    }

    const spend = spendFromMetadata(key, credits);
    const health: ProviderHealth = {
      credential: expiry,
      connectivity: "connected",
      spend: creditsFailed && spend !== "limit-reached" ? "unknown" : spend,
      runtime: "not-applicable",
      observedAt: this.#now(),
      generation,
    };
    let accountFingerprint: string | null = null;
    let identityFailure = false;
    if (typeof key.creatorUserId === "string" && key.creatorUserId.length > 0) {
      try {
        accountFingerprint = openRouterAccountFingerprint(
          await this.#credentials.getOrCreateAccountHmacKey(),
          key.creatorUserId,
        );
      } catch {
        identityFailure = true;
      }
    }

    const headline = deriveProviderHeadline(health);
    const routeEligible = health.credential === "valid"
      && health.connectivity === "connected"
      && health.spend !== "limit-reached"
      && accountFingerprint !== null;
    const explanationCode = explanationForSuccessfulKey({
      health,
      accountFingerprint,
      identityFailure,
      creditsAttempted,
      creditsFailed,
    });
    const qualifiers = health.spend === "unknown"
      ? Object.freeze(["Guthaben unbekannt"])
      : Object.freeze([] as string[]);
    const inspection: OpenRouterInspection = {
      backendId: "openrouter",
      connectionId: this.#connectionId,
      health,
      headline,
      accountFingerprint,
      billingRealm: "openrouter-payg",
      routeEligible,
      retryable: headline === "unknown" || (routeEligible && health.spend === "unknown"),
      explanationCode,
      qualifiers,
    };
    return {
      secret,
      balance: {
        key,
        ...(credits ? { credits } : {}),
        ...(!credits && health.spend === "unknown"
          ? { creditsUnavailableReason: "Guthaben unbekannt" }
          : {}),
      },
      inspection,
    };
  }

  #inspectionFromKeyFailure(error: unknown, generation: number): OpenRouterInspection {
    const status = error instanceof OpenRouterHttpError ? error.status : undefined;
    const failure = describeOpenRouterFailure(error);
    const credential = status === 401 ? "rejected" as const : "unknown" as const;
    const connectivity = status !== undefined
      ? "connected" as const
      : failure.kind === "network"
        ? "offline" as const
        : "unknown" as const;
    const health: ProviderHealth = {
      credential,
      connectivity,
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: this.#now(),
      generation,
    };
    return {
      backendId: "openrouter",
      connectionId: this.#connectionId,
      health,
      headline: deriveProviderHeadline(health),
      accountFingerprint: null,
      billingRealm: "openrouter-payg",
      routeEligible: false,
      retryable: credential !== "rejected",
      explanationCode: failure.kind === "cancelled"
        ? "openrouter-inspection-cancelled"
        : status === 401
          ? "openrouter-auth-rejected"
          : connectivity === "offline"
            ? "openrouter-offline"
            : failure.kind === "timeout"
              ? "openrouter-inspection-timeout"
              : "openrouter-inspection-unknown",
      qualifiers: Object.freeze([]),
    };
  }

  #emptyInspection(generation: number, explanationCode: string): OpenRouterInspection {
    const health: ProviderHealth = {
      credential: "unknown",
      connectivity: "unknown",
      spend: "unknown",
      runtime: "not-applicable",
      observedAt: this.#now(),
      generation,
    };
    return {
      backendId: "openrouter",
      connectionId: this.#connectionId,
      health,
      headline: "unknown",
      accountFingerprint: null,
      billingRealm: "openrouter-payg",
      routeEligible: false,
      retryable: true,
      explanationCode,
      qualifiers: Object.freeze([]),
    };
  }

  async #selectCredential(
    kind: CredentialKind,
    credential: CredentialRef,
    environmentName: "OPENROUTER_API_KEY" | "OPENROUTER_MANAGEMENT_KEY",
  ): Promise<SelectedCredential> {
    let saved: string | null;
    try {
      saved = typeof credential === "string"
        ? await this.#credentials.get(kind)
        : await this.#credentials.readSlot(credential);
    } catch {
      return { kind: "invalid" };
    }
    if (saved !== null) {
      try {
        return { kind: "available", secret: normalizeProviderSecret(saved) };
      } catch {
        return { kind: "invalid" };
      }
    }
    const processValue = this.#environment[environmentName];
    if (processValue === undefined || processValue.length === 0) {
      return { kind: "absent" };
    }
    try {
      return {
        kind: "available",
        secret: normalizeProviderSecret(processValue),
      };
    } catch {
      return { kind: "invalid" };
    }
  }
}

function credentialFromExpiry(
  expiresAt: string | null | undefined,
  now: number,
): ProviderHealth["credential"] {
  if (expiresAt === null || expiresAt === undefined) return "valid";
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) return "unknown";
  return parsed < now ? "expired" : "valid";
}

function spendFromMetadata(
  key: KeyInfo,
  credits: CreditInfo | undefined,
): ProviderHealth["spend"] {
  if (key.limitRemaining !== null && key.limitRemaining !== undefined
    && key.limitRemaining <= 0) {
    return "limit-reached";
  }
  if (!credits) return "unknown";
  return credits.remaining > 0 ? "available" : "limit-reached";
}

function explanationForSuccessfulKey(options: {
  health: ProviderHealth;
  accountFingerprint: string | null;
  identityFailure: boolean;
  creditsAttempted: boolean;
  creditsFailed: boolean;
}): string {
  if (options.health.credential === "expired") return "openrouter-credential-expired";
  if (options.health.credential === "unknown") return "openrouter-key-metadata-unknown";
  if (options.identityFailure) return "openrouter-account-identity-unavailable";
  if (options.accountFingerprint === null) return "openrouter-account-identity-missing";
  if (options.health.spend === "limit-reached") return "openrouter-limit-reached";
  if (options.creditsAttempted && options.creditsFailed) return "openrouter-credit-unknown";
  if (options.health.spend === "unknown") return "openrouter-ready-credit-unknown";
  return "openrouter-ready";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }
}
