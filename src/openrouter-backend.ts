import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  deriveProviderHeadline,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendModelDescriptor,
  type CandidateProviderState,
  type ProviderCandidate,
  type ProviderHealth,
  type ProviderInspectionRequest,
} from "./backends.js";
import {
  normalizeProviderSecret,
  type VersionedCredentialStoreLike,
} from "./credentials.js";
import type {
  ProviderAuthorityReadLease,
  ProviderCredentialAccessResult,
  ProviderCredentialAuthorityLike,
  ProviderConnectionBindingV2,
  ProviderCredentialUseContext,
} from "./provider-authority.js";
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

export interface OpenRouterBackendAdapterOptions {
  service: OpenRouterService;
  credentials: VersionedCredentialStoreLike;
  credentialAuthority: ProviderCredentialAuthorityLike;
  now?: () => number;
  createCandidateId?: () => string;
  createConnectionId?: () => string;
}

interface InspectedSecret {
  balance: BalanceReport;
  inspection: OpenRouterInspection;
  credentialProof?: {
    binding: ProviderConnectionBindingV2;
    source: "saved" | "environment";
    fingerprint: string;
  };
}

interface CandidateEntry extends InspectedSecret {
  candidateId: string;
  secret: string;
}

type InspectionCredentialAccess = (
  use: (secret: string, context: ProviderCredentialUseContext) => Promise<InspectedSecret>,
) => Promise<ProviderCredentialAccessResult<InspectedSecret>>;

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
  readonly #credentialAuthority: ProviderCredentialAuthorityLike;
  readonly #now: () => number;
  readonly #createCandidateId: () => string;
  readonly #createConnectionId: () => string;
  readonly #credentialProofKey = randomBytes(32);
  readonly #candidates = new Map<string, CandidateEntry>();
  readonly #activeInspections = new Map<string, InspectedSecret>();
  readonly #inspectionSequence = new Map<string, number>();

  constructor(options: OpenRouterBackendAdapterOptions) {
    this.#service = options.service;
    this.#credentials = options.credentials;
    this.#credentialAuthority = options.credentialAuthority;
    this.#now = options.now ?? Date.now;
    this.#createCandidateId = options.createCandidateId ?? randomUUID;
    this.#createConnectionId = options.createConnectionId ?? randomUUID;
  }

  async inspect(request: ProviderInspectionRequest): Promise<OpenRouterInspection> {
    return this.#inspectWithCredentialAccess(
      request,
      (use) => this.#credentialAuthority.withCredential(
        this.#credentialRequest(request),
        use,
      ),
    );
  }

  async inspectUnderAuthorityLease(
    request: ProviderInspectionRequest,
    lease: ProviderAuthorityReadLease,
  ): Promise<OpenRouterInspection> {
    if (!this.#credentialAuthority.withCredentialUnderLease) {
      return this.#emptyInspection(
        request.connectionId,
        request.generation,
        "openrouter-credential-unavailable",
      );
    }
    return this.#inspectWithCredentialAccess(
      request,
      (use) => this.#credentialAuthority.withCredentialUnderLease!(
        this.#credentialRequest(request),
        lease,
        use,
      ),
      lease,
    );
  }

  async #inspectWithCredentialAccess(
    request: ProviderInspectionRequest,
    access: InspectionCredentialAccess,
    authorityLease?: ProviderAuthorityReadLease,
  ): Promise<OpenRouterInspection> {
    const inspectionSequence = (this.#inspectionSequence.get(request.connectionId) ?? 0) + 1;
    this.#inspectionSequence.set(request.connectionId, inspectionSequence);
    this.#activeInspections.delete(request.connectionId);
    const selected = await access(
      (secret, context) => this.#inspectSecret(
        secret,
        request.connectionId,
        request.generation,
        request.deadlineAt,
        request.signal,
        authorityLease,
        {
          binding: structuredClone(context.binding),
          source: context.source,
          fingerprint: this.#credentialFingerprint(secret),
        },
      ),
    );
    if (selected.kind !== "available") {
      return this.#emptyInspection(
        request.connectionId,
        request.generation,
        explanationForCredentialAccess(selected),
      );
    }
    const inspected = selected.value;
    if (inspectionSequence === this.#inspectionSequence.get(request.connectionId)) {
      if (inspected.inspection.routeEligible) {
        this.#activeInspections.set(request.connectionId, inspected);
      } else {
        this.#activeInspections.delete(request.connectionId);
      }
    }
    return inspected.inspection;
  }

  #credentialRequest(request: ProviderInspectionRequest) {
    return {
      backendId: "openrouter" as const,
      connectionId: request.connectionId,
      credentialKind: "inference" as const,
      purpose: request.purpose ?? "startup-inspect",
      environmentEligibility: request.environmentEligibility ?? "automatic-if-no-saved",
      allowDisabled: request.allowDisabled ?? false,
      deadlineAt: request.deadlineAt,
      signal: request.signal,
    };
  }

  async connect(request: {
    connectionId?: string;
    candidate: unknown;
    generation: number;
    signal: AbortSignal;
  }): Promise<ProviderCandidate> {
    return this.#connectCandidate(request);
  }

  async connectUnderAuthorityLease(
    request: {
      connectionId?: string;
      candidate: unknown;
      generation: number;
      signal: AbortSignal;
    },
    lease: ProviderAuthorityReadLease,
  ): Promise<ProviderCandidate> {
    return this.#connectCandidate(request, lease);
  }

  async #connectCandidate(
    request: {
      connectionId?: string;
      candidate: unknown;
      generation: number;
      signal: AbortSignal;
    },
    authorityLease?: ProviderAuthorityReadLease,
  ): Promise<ProviderCandidate> {
    if (typeof request.candidate !== "string") {
      throw new Error("OpenRouter candidate input is invalid.");
    }
    const secret = normalizeProviderSecret(request.candidate);
    const inspected = await this.#inspectSecret(
      secret,
      request.connectionId ?? this.#createConnectionId(),
      request.generation,
      Number.MAX_SAFE_INTEGER,
      request.signal,
      authorityLease,
    );
    throwIfAborted(request.signal);
    const candidateId = this.#createCandidateId();
    if (inspected.inspection.routeEligible) {
      this.#candidates.set(candidateId, { ...inspected, candidateId, secret });
    }
    return {
      candidateId,
      backendId: "openrouter",
      connectionId: inspected.inspection.connectionId,
      accountFingerprint: inspected.inspection.accountFingerprint,
      billingRealm: "openrouter-payg",
      health: inspected.inspection.health,
    };
  }

  async listModels(request: {
    connectionId?: string;
    candidateId?: string;
    signal: AbortSignal;
  }): Promise<readonly BackendModelDescriptor[]> {
    const inspected = request.candidateId
      ? this.#candidates.get(request.candidateId) ?? null
      : request.connectionId
        ? this.#activeInspections.get(request.connectionId) ?? null
        : null;
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
    this.#activeInspections.set(candidate.inspection.connectionId, candidate);
    return {
      candidateId: request.candidateId,
      backendId: "openrouter",
      connectionId: candidate.inspection.connectionId,
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

  reconnect(request: ProviderInspectionRequest): Promise<OpenRouterInspection> {
    return this.inspect({ ...request, purpose: request.purpose ?? "reconnect" });
  }

  async bindRuntime(request: {
    connectionId: string;
    generation: number;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<void> {
    return this.#bindWithCredentialAccess(
      request,
      (use) => this.#credentialAuthority.withCredential(
        {
          backendId: "openrouter",
          connectionId: request.connectionId,
          credentialKind: "inference",
          purpose: "runtime-bind",
          environmentEligibility: "automatic-if-no-saved",
          deadlineAt: request.deadlineAt,
          signal: request.signal,
        },
        use,
      ),
    );
  }

  async bindRuntimeUnderAuthorityLease(
    request: {
      connectionId: string;
      generation: number;
      deadlineAt: number;
      signal: AbortSignal;
      allowDisabled?: boolean;
    },
    lease: ProviderAuthorityReadLease,
  ): Promise<void> {
    if (!this.#credentialAuthority.withCredentialUnderLease) {
      throw new Error("OpenRouter runtime credential binding is unavailable.");
    }
    return this.#bindWithCredentialAccess(
      request,
      (use) => this.#credentialAuthority.withCredentialUnderLease!(
        {
          backendId: "openrouter",
          connectionId: request.connectionId,
          credentialKind: "inference",
          purpose: "runtime-bind",
          environmentEligibility: "forbidden",
          allowDisabled: request.allowDisabled,
          deadlineAt: request.deadlineAt,
          signal: request.signal,
        },
        lease,
        use,
      ),
      lease,
    );
  }

  async #bindWithCredentialAccess(
    request: {
      connectionId: string;
      generation: number;
      deadlineAt: number;
      signal: AbortSignal;
    },
    access: (
      use: (secret: string, context: ProviderCredentialUseContext) => Promise<void>,
    ) => Promise<ProviderCredentialAccessResult<void>>,
    authorityLease?: ProviderAuthorityReadLease,
  ): Promise<void> {
    const inspected = this.#activeInspections.get(request.connectionId);
    if (
      !inspected
      || !inspected.inspection.routeEligible
      || inspected.inspection.health.generation !== request.generation
    ) {
      throw new Error("OpenRouter account inspection must be current before runtime binding.");
    }
    const selected = await access(
      async (secret, context) => {
        const proof = inspected.credentialProof;
        const fingerprint = this.#credentialFingerprint(secret);
        if (
          !proof
          || proof.source !== context.source
          || proof.fingerprint !== fingerprint
          || inspected.inspection.accountFingerprint !== context.binding.accountFingerprint
          || inspected.inspection.billingRealm !== context.binding.billingRealm
        ) {
          this.#activeInspections.delete(request.connectionId);
          throw new Error("OpenRouter credential inspection proof is stale.");
        }
        let authorized = inspected;
        const bindingChanged = !sameCredentialBinding(proof.binding, context.binding);
        if (bindingChanged) {
          authorized = await this.#inspectSecret(
            secret,
            request.connectionId,
            request.generation,
            request.deadlineAt,
            request.signal,
            authorityLease,
            {
              binding: structuredClone(context.binding),
              source: context.source,
              fingerprint,
            },
          );
          if (
            !authorized.inspection.routeEligible
            || authorized.inspection.accountFingerprint !== context.binding.accountFingerprint
            || authorized.inspection.billingRealm !== context.binding.billingRealm
          ) {
            this.#activeInspections.delete(request.connectionId);
            throw new Error("OpenRouter credential inspection proof is stale.");
          }
        }
        await this.#assertCredentialAttemptCurrent(request, authorityLease);
        await context.publishIfCurrent(() => {
          if (bindingChanged) {
            this.#activeInspections.set(request.connectionId, authorized);
          }
          this.#service.activateValidatedKey(
            secret,
            context.source === "saved" ? "keychain" : "environment",
            authorized.balance,
          );
        });
      },
    );
    if (selected.kind !== "available") {
      throw new Error("OpenRouter runtime credential binding is unavailable.");
    }
  }

  async #assertCredentialAttemptCurrent(
    request: {
      deadlineAt: number;
      signal: AbortSignal;
    },
    authorityLease?: ProviderAuthorityReadLease,
  ): Promise<void> {
    throwIfAborted(request.signal);
    if (!Number.isFinite(request.deadlineAt) || request.deadlineAt <= this.#now()) {
      throw new Error("OpenRouter runtime credential binding deadline expired.");
    }
    await authorityLease?.assertHeld();
    throwIfAborted(request.signal);
    if (request.deadlineAt <= this.#now()) {
      throw new Error("OpenRouter runtime credential binding deadline expired.");
    }
  }

  async logout(request: { signal: AbortSignal }): Promise<void> {
    throwIfAborted(request.signal);
    this.#activeInspections.clear();
    this.#service.forgetKey();
    this.#service.forgetManagementKey();
  }

  async discardCandidate(candidateId: string): Promise<void> {
    this.#candidates.delete(candidateId);
  }

  async #inspectSecret(
    secret: string,
    connectionId: string,
    generation: number,
    deadlineAt: number,
    signal: AbortSignal,
    authorityLease?: ProviderAuthorityReadLease,
    credentialProof?: InspectedSecret["credentialProof"],
  ): Promise<InspectedSecret> {
    let key: KeyInfo;
    try {
      key = await this.#service.inspectKey(secret, signal);
    } catch (error) {
      if (authorityLease) {
        await this.#assertCredentialAttemptCurrent({ deadlineAt, signal }, authorityLease);
      }
      return {
        balance: { key: {} },
        inspection: this.#inspectionFromKeyFailure(error, connectionId, generation),
      };
    }
    await this.#assertCredentialAttemptCurrent({ deadlineAt, signal }, authorityLease);

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
      try {
        const managementRequest = {
          backendId: "openrouter" as const,
          connectionId,
          credentialKind: "management" as const,
          purpose: "startup-inspect" as const,
          environmentEligibility: "automatic-if-no-saved" as const,
          deadlineAt,
          signal,
        };
        const useManagement = (managementSecret: string) => this.#service.getCredits(
          managementSecret,
          signal,
          "candidate",
        );
        const management = authorityLease && this.#credentialAuthority.withCredentialUnderLease
          ? await this.#credentialAuthority.withCredentialUnderLease(
              managementRequest,
              authorityLease,
              useManagement,
            )
          : await this.#credentialAuthority.withCredential(
              managementRequest,
              useManagement,
            );
        if (management.kind === "available") {
          creditsAttempted = true;
          credits = management.value;
        } else if (management.kind === "invalid") {
          creditsFailed = true;
        }
      } catch {
        throwIfAborted(signal);
        creditsAttempted = true;
        creditsFailed = true;
      }
    }
    await this.#assertCredentialAttemptCurrent({ deadlineAt, signal }, authorityLease);

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
        await this.#assertCredentialAttemptCurrent({ deadlineAt, signal }, authorityLease);
        const accountHmacKey = await this.#credentials.getOrCreateAccountHmacKey();
        await this.#assertCredentialAttemptCurrent({ deadlineAt, signal }, authorityLease);
        accountFingerprint = openRouterAccountFingerprint(
          accountHmacKey,
          key.creatorUserId,
        );
      } catch {
        await this.#assertCredentialAttemptCurrent({ deadlineAt, signal }, authorityLease);
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
      connectionId,
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
      balance: {
        key,
        ...(credits ? { credits } : {}),
        ...(!credits && health.spend === "unknown"
          ? { creditsUnavailableReason: "Guthaben unbekannt" }
          : {}),
      },
      inspection,
      ...(credentialProof ? { credentialProof } : {}),
    };
  }

  #credentialFingerprint(secret: string): string {
    return createHmac("sha256", this.#credentialProofKey)
      .update("orcode-provider-credential-proof/v1\0", "utf8")
      .update(secret, "utf8")
      .digest("base64url");
  }

  #inspectionFromKeyFailure(
    error: unknown,
    connectionId: string,
    generation: number,
  ): OpenRouterInspection {
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
      connectionId,
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

  #emptyInspection(
    connectionId: string,
    generation: number,
    explanationCode: string,
  ): OpenRouterInspection {
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
      connectionId,
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

}

function sameCredentialBinding(
  left: ProviderConnectionBindingV2,
  right: ProviderConnectionBindingV2,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function explanationForCredentialAccess(
  result: Exclude<ProviderCredentialAccessResult<unknown>, { kind: "available" }>,
): string {
  if (result.kind === "forget-pending") return "openrouter-credential-forget-pending";
  if (result.kind === "invalid-pointer") return "openrouter-credential-invalid-pointer";
  if (result.kind === "stale") return "openrouter-credential-stale";
  if (result.kind === "absent" || result.kind === "disabled" || result.kind === "none") {
    return "openrouter-credential-missing";
  }
  return "openrouter-credential-unavailable";
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
