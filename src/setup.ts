import {
  ProviderSetupRequiredError,
  deriveProviderHeadline,
  type BackendAdapter,
  type BackendId,
  type BackendMaturity,
  type BackendModelDescriptor,
  type BackendRegistry,
  type BillingRealm,
  type ProviderHeadline,
  type ProviderHealth,
  type ProviderInspection,
  type RouteIdentityV1,
} from "./backends.js";
import type {
  ProviderActivationCoordinator,
  ProviderActivationRequest,
  ProviderActivationResult,
} from "./provider-activation.js";
import {
  readProviderStateCommitAdoption,
  type ProviderConnectionStateV1,
  type ProviderSetupStateV2,
  type ProviderStateStore,
} from "./provider-state.js";

export { ProviderSetupRequiredError };

const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_TIMEOUT_MS = 15_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const MAX_STARTUP_TIMEOUT_MS = 30_000;

export interface SetupClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type StartupSetupMode =
  | "ready"
  | "ready-with-warning"
  | "route-choice-required"
  | "setup-required";

export type SetupEvent =
  | { version: 1; type: "inspection-start"; backendId: BackendId; generation: number }
  | { version: 1; type: "inspection-end"; backendId: BackendId; maturity: BackendMaturity; generation: number; durationMs: number; health: ProviderHealth; headline: ProviderHeadline; accountFingerprint: string | null; billingRealm: BillingRealm }
  | { version: 1; type: "inspection-discarded"; backendId: BackendId; generation: number; reason: "stale-generation" }
  | { version: 1; type: "candidate-activation"; backendId: BackendId; generation: number; connectionId: string; route: RouteIdentityV1 }
  | { version: 1; type: "setup-required"; generation: number }
  | { version: 1; type: "route-choice-required"; generation: number; routeIds: readonly string[] }
  | { version: 1; type: "warning"; generation: number; code: string; message: string }
  | { version: 1; type: "terminal-failure"; backendId: BackendId | null; generation: number; code: string; retryable: boolean; message: string };

export interface StartupSetupResult {
  mode: StartupSetupMode;
  generation: number;
  defaultRoute: RouteIdentityV1 | null;
  readyRoutes: readonly RouteIdentityV1[];
  warnings: readonly string[];
  crossEnabled: false;
}

export interface StartupInspectionOptions {
  signal?: AbortSignal;
  providerTimeoutMs?: number;
  startupTimeoutMs?: number;
  deadlineAt?: number;
  connectionId?: string;
}

export class ProviderInspectionTimeoutError extends Error {
  readonly code = "provider-inspection-timeout" as const;

  constructor(
    readonly scope: "provider" | "startup",
    readonly backendId: BackendId | null,
    readonly timeoutMs: number,
  ) {
    super(scope === "provider"
      ? "Provider inspection reached its deadline."
      : "Provider startup inspection reached its deadline.");
    this.name = "ProviderInspectionTimeoutError";
  }
}

interface ActivationCoordinatorLike {
  activate(
    request: ProviderActivationRequest,
  ): ReturnType<ProviderActivationCoordinator["activate"]>;
}

export interface SetupOrchestratorOptions {
  registry: BackendRegistry;
  stateStore: ProviderStateStore;
  activationCoordinator: ActivationCoordinatorLike;
  clock?: SetupClock;
  providerTimeoutMs?: number;
  startupTimeoutMs?: number;
  emit?: (event: SetupEvent) => void;
}

interface ProbeTarget {
  connection: ProviderConnectionStateV1;
  adapter: BackendAdapter;
  maturity: BackendMaturity;
}

interface AttemptToken {
  generation: number;
  backendId: BackendId;
  connectionId: string;
  controller: AbortController;
  closed: boolean;
  superseded: boolean;
  discardEmitted: boolean;
}

interface GenerationToken {
  generation: number;
  closed: boolean;
}

interface NormalizedInspection {
  backendId: BackendId;
  connectionId: string;
  health: ProviderHealth;
  headline: ProviderHeadline;
  accountFingerprint: string | null;
  billingRealm: BillingRealm;
  routeEligible: boolean;
}

type ProbeOutcome =
  | { kind: "completed"; target: ProbeTarget; token: AttemptToken; durationMs: number; inspection: NormalizedInspection }
  | { kind: "timeout" | "error"; target: ProbeTarget; token: AttemptToken; durationMs: number; inspection: NormalizedInspection }
  | { kind: "invalid" | "stale" | "cancelled"; target: ProbeTarget; token: AttemptToken; durationMs: number };

interface InspectionProof {
  generation: number;
  stateRevision: number;
  backendId: BackendId;
  connectionId: string;
  accountFingerprint: string;
  billingRealm: BillingRealm;
}

interface ApplyResult {
  state: ProviderSetupStateV2;
  changed: boolean;
}

interface BoundedModelsResult {
  kind: "models" | "timeout" | "error" | "stale" | "cancelled";
  models?: readonly BackendModelDescriptor[];
}

const SYSTEM_CLOCK: SetupClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ProviderStartupStepContext {
  generation: number;
  deadlineAt: number;
  signal: AbortSignal;
  remainingMs(): number;
  assertCurrent(): void;
}

export interface ProviderStartupAttemptInput {
  generation: number;
  clock?: SetupClock;
  timeoutMs?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
  recover(context: ProviderStartupStepContext): Promise<void>;
  inspect(context: ProviderStartupStepContext): Promise<StartupSetupResult>;
  resolveLegacy?(
    result: StartupSetupResult,
    context: ProviderStartupStepContext,
  ): Promise<StartupSetupResult>;
  automaticEnvironment?(
    result: StartupSetupResult,
    context: ProviderStartupStepContext,
  ): Promise<StartupSetupResult>;
  bindRuntime?(
    result: StartupSetupResult,
    context: ProviderStartupStepContext,
  ): Promise<void>;
}

export interface SetupCancellationRequest {
  /** Kept by identity at the caller boundary; never rendered or persisted. */
  reason: unknown;
  /** Durable setup state observed before the first interactive prompt. */
  expectedRevision?: number;
  /** Whole-startup generation, when cancellation belongs to that attempt. */
  expectedGeneration?: number;
}

/** One abortable budget for every startup phase, including recovery. */
export async function runProviderStartupAttempt(
  input: ProviderStartupAttemptInput,
): Promise<StartupSetupResult> {
  const clock = input.clock ?? SYSTEM_CLOCK;
  const startedAt = clock.now();
  assertFiniteNow(startedAt);
  const timeoutMs = boundedTimeout(
    input.timeoutMs,
    DEFAULT_STARTUP_TIMEOUT_MS,
    MAX_STARTUP_TIMEOUT_MS,
    "startup",
  );
  const deadlineAt = Math.min(input.deadlineAt ?? Number.POSITIVE_INFINITY, startedAt + timeoutMs);
  const controller = new AbortController();
  let closed = false;
  const abortFromCaller = () => {
    if (!controller.signal.aborted) controller.abort(abortReason(input.signal!));
  };
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (input.signal?.aborted) abortFromCaller();
  const timeoutReason = new ProviderInspectionTimeoutError(
    "startup",
    null,
    Math.max(0, deadlineAt - startedAt),
  );
  const timer = clock.setTimeout(() => {
    closed = true;
    if (!controller.signal.aborted) controller.abort(timeoutReason);
  }, Math.max(0, deadlineAt - startedAt));
  const context: ProviderStartupStepContext = {
    generation: input.generation,
    deadlineAt,
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - clock.now()),
    assertCurrent: () => {
      if (closed || controller.signal.aborted || clock.now() >= deadlineAt) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : timeoutReason;
      }
    },
  };
  const failed = (): StartupSetupResult => freezeResult({
    mode: "setup-required",
    generation: input.generation,
    defaultRoute: null,
    readyRoutes: [],
    warnings: [],
    crossEnabled: false,
  });
  const phase = async <T>(run: () => Promise<T>): Promise<
    { kind: "value"; value: T } | { kind: "stopped" }
  > => {
    if (closed || controller.signal.aborted || context.remainingMs() <= 0) {
      closed = true;
      if (!controller.signal.aborted) controller.abort(timeoutReason);
      return { kind: "stopped" };
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { kind: "value"; value: T } | { kind: "stopped" }) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish({ kind: "stopped" });
      controller.signal.addEventListener("abort", onAbort, { once: true });
      let operation: Promise<T>;
      try {
        operation = run();
      } catch {
        finish({ kind: "stopped" });
        return;
      }
      operation.then(
        (value) => finish(closed || controller.signal.aborted
          ? { kind: "stopped" }
          : { kind: "value", value }),
        () => finish({ kind: "stopped" }),
      );
    });
  };

  try {
    const recovered = await phase(() => input.recover(context));
    if (recovered.kind === "stopped") return failed();
    context.assertCurrent();
    const inspected = await phase(() => input.inspect(context));
    if (inspected.kind === "stopped") return failed();
    context.assertCurrent();
    let result = inspected.value;
    if (input.resolveLegacy) {
      const legacy = await phase(() => input.resolveLegacy!(result, context));
      if (legacy.kind === "stopped") return failed();
      context.assertCurrent();
      result = legacy.value;
    }
    if (input.automaticEnvironment) {
      const automatic = await phase(() => input.automaticEnvironment!(result, context));
      if (automatic.kind === "stopped") return failed();
      context.assertCurrent();
      result = automatic.value;
    }
    if (input.bindRuntime && (result.mode === "ready" || result.mode === "ready-with-warning")) {
      const bound = await phase(() => input.bindRuntime!(result, context));
      if (bound.kind === "stopped") return failed();
      context.assertCurrent();
    }
    return result;
  } finally {
    clock.clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export class SetupOrchestrator {
  readonly #registry: BackendRegistry;
  readonly #stateStore: ProviderStateStore;
  readonly #activationCoordinator: ActivationCoordinatorLike;
  readonly #clock: SetupClock;
  readonly #emitCallback: (event: SetupEvent) => void;
  readonly #providerTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #activeProbes = new Set<AttemptToken>();
  readonly #proofs = new Map<string, InspectionProof>();
  readonly #legacyResolutionAttempts = new Set<string>();
  #generation = 0;
  #nextGeneration = 0;
  #latestResult: StartupSetupResult | null = null;
  #activationInFlight: Promise<void> | null = null;
  #currentGeneration: GenerationToken | null = null;

  constructor(options: SetupOrchestratorOptions) {
    this.#registry = options.registry;
    this.#stateStore = options.stateStore;
    this.#activationCoordinator = options.activationCoordinator;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#emitCallback = options.emit ?? (() => undefined);
    this.#providerTimeoutMs = boundedTimeout(
      options.providerTimeoutMs,
      DEFAULT_PROVIDER_TIMEOUT_MS,
      MAX_PROVIDER_TIMEOUT_MS,
      "provider",
    );
    this.#startupTimeoutMs = boundedTimeout(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      MAX_STARTUP_TIMEOUT_MS,
      "startup",
    );
    assertFiniteNow(this.#clock.now());
  }

  /** Generation chosen before whole-startup recovery begins. */
  nextStartupGeneration(): number {
    return Math.max(this.#nextGeneration, this.#generation) + 1;
  }

  async inspectStartup(options: StartupInspectionOptions = {}): Promise<StartupSetupResult> {
    const token = this.#reserveGeneration();
    try {
      if (!(await this.#awaitGenerationTurn(token))) return this.#staleResult();
      return await this.#inspectGeneration(token, "inspect", undefined, options);
    } finally {
      token.closed = true;
    }
  }

  async reconnect(
    backendId: BackendId,
    options: StartupInspectionOptions = {},
  ): Promise<StartupSetupResult> {
    const token = this.#reserveGeneration();
    try {
      if (!(await this.#awaitGenerationTurn(token))) return this.#staleResult();
      return await this.#inspectGeneration(token, "reconnect", backendId, options);
    } finally {
      token.closed = true;
    }
  }

  async cancelSetup(request: SetupCancellationRequest): Promise<StartupSetupResult> {
    // Capture before waiting for an activation. A cancellation that began on
    // older authority must never cancel the state committed by that activation.
    const captured = this.#stateStore.read();
    if (
      request.expectedRevision !== undefined
      && request.expectedRevision !== captured.revision
    ) {
      return this.#latestResult
        ?? this.#setupRequiredResult(captured, this.#generation);
    }

    let token: GenerationToken;
    if (request.expectedGeneration !== undefined) {
      const expected = request.expectedGeneration;
      if (
        !Number.isSafeInteger(expected)
        || expected < 1
        || expected < this.#generation
        || expected < this.#nextGeneration
      ) {
        return this.#latestResult
          ?? this.#setupRequiredResult(captured, this.#generation);
      }
      if (this.#currentGeneration) this.#currentGeneration.closed = true;
      this.#supersedeActiveProbes();
      this.#generation = expected;
      this.#nextGeneration = Math.max(this.#nextGeneration, expected);
      token = { generation: expected, closed: false };
      this.#currentGeneration = token;
    } else {
      token = this.#reserveGeneration();
    }
    try {
      if (!(await this.#awaitGenerationTurn(token))) return this.#staleResult();
      const current = this.#stateStore.read();
      if (
        current.revision !== captured.revision
        || JSON.stringify(current) !== JSON.stringify(captured)
      ) {
        return this.#latestResult
          ?? this.#setupRequiredResult(current, token.generation);
      }
      let state: ProviderSetupStateV2;
      try {
        state = await this.#commitCancelled(captured, token.generation);
      } catch (error) {
        const afterFailure = this.#stateStore.read();
        if (
          !this.#ownsGeneration(token)
          || afterFailure.revision !== captured.revision
          || JSON.stringify(afterFailure) !== JSON.stringify(captured)
        ) {
          return this.#latestResult
            ?? this.#setupRequiredResult(afterFailure, token.generation);
        }
        throw error;
      }
      if (!this.#ownsGeneration(token)) return this.#staleResult();
      const result = this.#setupRequiredResult(state, token.generation);
      this.#latestResult = result;
      this.#proofs.clear();
      this.#emit({ version: 1, type: "setup-required", generation: token.generation });
      if (!this.#ownsGeneration(token)) return this.#staleResult();
      return result;
    } finally {
      token.closed = true;
    }
  }

  ensureRunnableRoute(requestedRoute?: RouteIdentityV1): RouteIdentityV1 {
    const result = this.#latestResult;
    const state = this.#stateStore.read();
    const current = state.defaultRoute;
    if (
      requestedRoute
      && result
      && result.generation === this.#generation
      && this.#currentGeneration?.generation === this.#generation
      && this.#currentGeneration.closed
      && isResolvedRoute(requestedRoute)
      && this.#routeHasProof(requestedRoute, state, result.generation)
    ) {
      return structuredClone(requestedRoute);
    }
    if (
      result
      && result.generation === this.#generation
      && this.#currentGeneration?.generation === this.#generation
      && this.#currentGeneration.closed
      && (result.mode === "ready" || result.mode === "ready-with-warning")
      && current
      && isResolvedRoute(current)
      && this.#routeHasProof(current, state, result.generation)
      && result.readyRoutes.some((candidate) => sameResolvedRoute(candidate, current))
    ) {
      return structuredClone(current);
    }
    throw new ProviderSetupRequiredError();
  }

  async activateCandidate(
    request: Omit<ProviderActivationRequest, "generation"> & { startupGeneration?: number },
  ): Promise<ProviderActivationResult> {
    let releaseActivation!: () => void;
    const ownGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const priorActivation = this.#activationInFlight;
    const activationTail = priorActivation
      ? priorActivation.then(() => ownGate)
      : ownGate;
    this.#activationInFlight = activationTail;
    try {
      if (priorActivation) await priorActivation;
      if (this.#currentGeneration) this.#currentGeneration.closed = true;
      this.#supersedeActiveProbes();
      this.#proofs.clear();
      const { startupGeneration, ...activationRequest } = request;
      let generation: number;
      if (startupGeneration === undefined) {
        this.#nextGeneration = Math.max(this.#nextGeneration, this.#generation) + 1;
        generation = this.#nextGeneration;
      } else {
        if (
          !Number.isSafeInteger(startupGeneration)
          || startupGeneration < 1
          || startupGeneration < this.#generation
          || startupGeneration < this.#nextGeneration
        ) {
          throw new Error("Provider startup activation generation is stale.");
        }
        generation = startupGeneration;
        this.#nextGeneration = Math.max(this.#nextGeneration, generation);
      }
      this.#generation = generation;
      const result = await this.#activationCoordinator.activate({
        ...activationRequest,
        generation,
      });
      if (generation !== this.#generation) return result;
      const safeRoute = safeRouteIdentity(result.route);
      if (!safeRoute) return result;
      const state = result.state ?? this.#stateStore.read();
      const connection = state.connections.find((candidate) =>
        candidate.enabled
        && candidate.backendId === safeRoute.backendId
        && candidate.accountFingerprint === safeRoute.accountFingerprint
        && candidate.billingRealm === safeRoute.billingRealm
      );
      if (connection) {
        this.#emit({
          version: 1,
          type: "candidate-activation",
          backendId: safeRoute.backendId,
          generation,
          connectionId: connection.id,
          route: safeRoute,
        });
      }
      return result;
    } finally {
      releaseActivation();
      if (this.#activationInFlight === activationTail) this.#activationInFlight = null;
    }
  }

  async resolveLegacyDefaultRoute(
    options: Pick<StartupInspectionOptions, "signal" | "providerTimeoutMs" | "deadlineAt"> = {},
  ): Promise<StartupSetupResult> {
    const generation = this.#generation;
    const captured = this.#stateStore.read();
    if (options.signal?.aborted) {
      await this.#handleLegacyCallerCancellation(captured, generation, options.signal);
    }
    const legacyRoute = captured.defaultRoute;
    if (!legacyRoute || legacyRoute.resolutionState !== "legacy-unverified") {
      const result = this.#reduce(captured, generation, []);
      this.#latestResult = result;
      return result;
    }

    const matchingConnections = captured.connections.filter((candidate) =>
      candidate.enabled
      && candidate.accountFingerprintState === "verified"
      && candidate.backendId === legacyRoute.backendId
      && candidate.accountFingerprint === legacyRoute.accountFingerprint
      && candidate.billingRealm === legacyRoute.billingRealm
    );
    const connection = matchingConnections.length === 1
      ? matchingConnections[0]
      : undefined;
    const proof = connection ? this.#proofs.get(connection.id) : undefined;
    if (
      !connection
      || !proof
      || proof.generation !== generation
      || proof.stateRevision !== captured.revision
      || proof.accountFingerprint !== connection.accountFingerprint
      || proof.billingRealm !== connection.billingRealm
    ) {
      return this.#publishRouteChoice(captured, generation, legacyRoute);
    }

    const attemptKey = `${generation}:${captured.revision}:${routeId(legacyRoute)}`;
    if (this.#legacyResolutionAttempts.has(attemptKey)) {
      return this.#publishRouteChoice(captured, generation, legacyRoute);
    }
    this.#legacyResolutionAttempts.add(attemptKey);

    let adapter: BackendAdapter;
    try {
      adapter = this.#registry.adapter(connection.backendId);
    } catch {
      return this.#publishRouteChoice(captured, generation, legacyRoute);
    }

    const modelsResult = await this.#listModelsBounded(
      adapter,
      connection.id,
      generation,
      Math.min(boundedTimeout(
        options.providerTimeoutMs,
        this.#providerTimeoutMs,
        MAX_PROVIDER_TIMEOUT_MS,
        "provider",
      ), options.deadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, options.deadlineAt - this.#clock.now())),
      options.signal,
    );
    if (modelsResult.kind === "cancelled") {
      await this.#handleLegacyCallerCancellation(
        this.#stateStore.read(),
        generation,
        options.signal!,
      );
    }
    if (modelsResult.kind === "stale") {
      return this.#latestResult
        ?? this.#setupRequiredResult(this.#stateStore.read(), generation);
    }
    if (modelsResult.kind !== "models") {
      return this.#publishRouteChoice(this.#stateStore.read(), generation, legacyRoute);
    }

    const current = this.#stateStore.read();
    if (generation !== this.#generation) {
      return this.#latestResult ?? this.#setupRequiredResult(current, generation);
    }
    if (
      current.revision !== captured.revision
      || JSON.stringify(current) !== JSON.stringify(captured)
    ) {
      return this.#publishRouteChoice(current, generation, current.defaultRoute ?? legacyRoute);
    }

    const exact = (modelsResult.models ?? []).filter((candidate) =>
      candidate.backendId === legacyRoute.backendId
      && candidate.requestedModelId === legacyRoute.requestedModelId
      && candidate.canonicalModelId.length > 0
      && candidate.capabilities.textInput
      && candidate.capabilities.textOutput
    );
    const canonicalIds = new Set(exact.map((candidate) => candidate.canonicalModelId));
    if (exact.length === 0 || canonicalIds.size !== 1) {
      return this.#publishRouteChoice(captured, generation, legacyRoute);
    }
    const canonicalModelId = exact[0]!.canonicalModelId;

    let committed: ProviderSetupStateV2;
    try {
      committed = await this.#stateStore.commit(
        captured.revision,
        (authoritative) => {
          if (JSON.stringify(authoritative) !== JSON.stringify(captured)) {
            throw new Error("Provider state changed during legacy model resolution.");
          }
          return {
            ...authoritative,
            defaultRoute: {
              ...legacyRoute,
              canonicalModelId,
              resolutionState: "resolved",
            },
          };
        },
        () => {
          if (generation !== this.#generation) {
            throw new Error("Legacy model resolution generation is stale.");
          }
        },
      );
    } catch {
      if (options.signal?.aborted) {
        await this.#handleLegacyCallerCancellation(
          this.#stateStore.read(),
          generation,
          options.signal,
        );
      }
      if (generation !== this.#generation) {
        return this.#latestResult
          ?? this.#setupRequiredResult(this.#stateStore.read(), generation);
      }
      return this.#publishRouteChoice(this.#stateStore.read(), generation, legacyRoute);
    }
    if (options.signal?.aborted) {
      await this.#handleLegacyCallerCancellation(
        this.#stateStore.read(),
        generation,
        options.signal,
      );
    }
    if (generation !== this.#generation) return this.#staleResult();
    const currentProof = this.#proofs.get(connection.id);
    if (currentProof && currentProof.generation === generation) {
      this.#proofs.set(connection.id, {
        ...currentProof,
        stateRevision: committed.revision,
      });
    }
    const result = this.#reduce(committed, generation, []);
    this.#latestResult = result;
    return result;
  }

  #reserveGeneration(): GenerationToken {
    if (this.#currentGeneration) this.#currentGeneration.closed = true;
    this.#supersedeActiveProbes();
    this.#proofs.clear();
    this.#nextGeneration = Math.max(this.#nextGeneration, this.#generation) + 1;
    const token: GenerationToken = {
      generation: this.#nextGeneration,
      closed: false,
    };
    this.#currentGeneration = token;
    return token;
  }

  async #awaitGenerationTurn(token: GenerationToken): Promise<boolean> {
    while (this.#activationInFlight) {
      await this.#activationInFlight;
      if (!this.#ownsReservation(token)) return false;
    }
    if (!this.#ownsReservation(token)) return false;
    this.#generation = token.generation;
    this.#supersedeActiveProbes();
    return this.#ownsGeneration(token);
  }

  #ownsReservation(token: GenerationToken): boolean {
    return !token.closed && token === this.#currentGeneration;
  }

  #ownsGeneration(token: GenerationToken): boolean {
    return this.#ownsReservation(token)
      && token.generation === this.#generation;
  }

  #staleResult(): StartupSetupResult {
    if (
      this.#latestResult?.generation === this.#generation
      && this.#currentGeneration?.generation === this.#generation
      && this.#currentGeneration.closed
    ) return this.#latestResult;
    return this.#setupRequiredResult(this.#stateStore.read(), this.#generation);
  }

  #supersedeActiveProbes(): void {
    for (const token of [...this.#activeProbes]) {
      if (token.closed) continue;
      token.superseded = true;
      token.controller.abort(new DOMException("Provider inspection superseded.", "AbortError"));
    }
  }

  async #inspectGeneration(
    generationToken: GenerationToken,
    method: "inspect" | "reconnect",
    backendId: BackendId | undefined,
    options: StartupInspectionOptions,
  ): Promise<StartupSetupResult> {
    if (!this.#ownsGeneration(generationToken)) return this.#staleResult();
    const generation = generationToken.generation;
    const captured = this.#stateStore.read();
    if (options.signal?.aborted) {
      await this.#handleCallerCancellation(captured, generationToken, options.signal);
    }
    const targets = this.#targets(captured, backendId, options.connectionId);
    if (targets.length === 0) {
      if (!this.#ownsGeneration(generationToken)) return this.#staleResult();
      const result = this.#reduce(captured, generation, []);
      this.#latestResult = result;
      this.#proofs.clear();
      this.#publishModeEvent(result, captured.defaultRoute);
      if (!this.#ownsGeneration(generationToken)) return this.#staleResult();
      return result;
    }

    const configuredProviderTimeoutMs = boundedTimeout(
      options.providerTimeoutMs,
      this.#providerTimeoutMs,
      MAX_PROVIDER_TIMEOUT_MS,
      "provider",
    );
    const configuredStartupTimeoutMs = boundedTimeout(
      options.startupTimeoutMs,
      this.#startupTimeoutMs,
      MAX_STARTUP_TIMEOUT_MS,
      "startup",
    );
    const now = this.#clock.now();
    assertFiniteNow(now);
    const externalRemaining = options.deadlineAt === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, options.deadlineAt - now);
    const startupTimeoutMs = Math.min(configuredStartupTimeoutMs, externalRemaining);
    const providerTimeoutMs = Math.min(configuredProviderTimeoutMs, startupTimeoutMs);
    const deadlineAt = now + startupTimeoutMs;
    const cancelOutstanding = () => {
      const reason = abortReason(options.signal!);
      for (const token of this.#activeProbes) {
        if (token.generation === generation && !token.closed) token.controller.abort(reason);
      }
    };
    options.signal?.addEventListener("abort", cancelOutstanding, { once: true });
    const wholeTimer = this.#clock.setTimeout(() => {
      for (const token of this.#activeProbes) {
        if (token.generation !== generation || token.closed) continue;
        token.controller.abort(new ProviderInspectionTimeoutError(
          "startup",
          null,
          startupTimeoutMs,
        ));
      }
    }, startupTimeoutMs);
    // Register the whole-attempt timer before equal-deadline provider timers so
    // the primary timeout identity remains "startup" at the shared bound.
    const probePromises = targets.map((target) =>
      this.#runProbe(target, method, generationToken, providerTimeoutMs, deadlineAt)
    );

    let outcomes: ProbeOutcome[];
    try {
      outcomes = await Promise.all(probePromises);
    } finally {
      this.#clock.clearTimeout(wholeTimer);
      options.signal?.removeEventListener("abort", cancelOutstanding);
    }

    if (options.signal?.aborted) {
      await this.#handleCallerCancellation(this.#stateStore.read(), generationToken, options.signal);
    }
    if (!this.#ownsGeneration(generationToken) || outcomes.some((outcome) => outcome.kind === "stale")) {
      return this.#staleResult();
    }

    const preview = applyOutcomes(captured, outcomes);
    let authoritative = captured;
    if (preview.changed) {
      try {
        authoritative = await this.#stateStore.commit(
          captured.revision,
          (current) => {
            if (JSON.stringify(current) !== JSON.stringify(captured)) {
              throw new Error("Provider state changed during inspection.");
            }
            return applyOutcomes(current, outcomes).state;
          },
          () => {
            if (!this.#ownsGeneration(generationToken)) {
              throw new Error("Provider inspection generation is stale.");
            }
          },
        );
      } catch {
        this.#invalidateGeneration(generation, outcomes);
        return this.#staleResult();
      }
      if (options.signal?.aborted) {
        await this.#handleCallerCancellation(
          this.#stateStore.read(),
          generationToken,
          options.signal,
        );
      }
      if (!this.#ownsGeneration(generationToken)) {
        this.#invalidateGeneration(generation, outcomes);
        return this.#staleResult();
      }
    } else {
      const current = this.#stateStore.read();
      if (
        current.revision !== captured.revision
        || JSON.stringify(current) !== JSON.stringify(captured)
      ) {
        this.#invalidateGeneration(generation, outcomes);
        return this.#staleResult();
      }
    }

    if (!this.#ownsGeneration(generationToken)) {
      this.#invalidateGeneration(generation, outcomes);
      return this.#staleResult();
    }
    this.#proofs.clear();
    if (!this.#publishInspectionEvents(
      outcomes,
      authoritative,
      generationToken,
    )) return this.#staleResult();
    this.#recordProofs(outcomes, authoritative, generation);
    const result = this.#reduce(authoritative, generation, outcomes);
    if (!this.#ownsGeneration(generationToken)) return this.#staleResult();
    this.#latestResult = result;
    this.#publishModeEvent(result, authoritative.defaultRoute);
    if (!this.#ownsGeneration(generationToken)) return this.#staleResult();
    return result;
  }

  #targets(
    state: ProviderSetupStateV2,
    backendId?: BackendId,
    connectionId?: string,
  ): ProbeTarget[] {
    const targets: ProbeTarget[] = [];
    for (const current of state.connections) {
      if (
        !current.enabled
        || (backendId && current.backendId !== backendId)
        || (connectionId && current.id !== connectionId)
      ) continue;
      try {
        const descriptor = this.#registry.descriptor(current.backendId);
        if (!descriptor.connectable || descriptor.maturity === "coming-soon") continue;
        targets.push({
          connection: structuredClone(current),
          adapter: this.#registry.adapter(current.backendId),
          maturity: descriptor.maturity,
        });
      } catch {
        continue;
      }
    }
    return targets;
  }

  #runProbe(
    target: ProbeTarget,
    method: "inspect" | "reconnect",
    generationToken: GenerationToken,
    timeoutMs: number,
    deadlineAt: number,
  ): Promise<ProbeOutcome> {
    const generation = generationToken.generation;
    if (!this.#ownsGeneration(generationToken)) {
      return Promise.resolve({
        kind: "stale",
        target,
        token: {
          generation,
          backendId: target.connection.backendId,
          connectionId: target.connection.id,
          controller: new AbortController(),
          closed: true,
          superseded: true,
          discardEmitted: true,
        },
        durationMs: 0,
      });
    }
    const startedAt = this.#clock.now();
    assertFiniteNow(startedAt);
    const controller = new AbortController();
    const token: AttemptToken = {
      generation,
      backendId: target.connection.backendId,
      connectionId: target.connection.id,
      controller,
      closed: false,
      superseded: false,
      discardEmitted: false,
    };
    this.#activeProbes.add(token);
    this.#emit({
      version: 1,
      type: "inspection-start",
      backendId: target.connection.backendId,
      generation,
    });
    if (!this.#ownsGeneration(generationToken)) {
      token.closed = true;
      token.superseded = true;
      this.#activeProbes.delete(token);
      token.discardEmitted = true;
      this.#emit({
        version: 1,
        type: "inspection-discarded",
        backendId: target.connection.backendId,
        generation,
        reason: "stale-generation",
      });
      return Promise.resolve({
        kind: "stale",
        target,
        token,
        durationMs: Math.max(0, this.#clock.now() - startedAt),
      });
    }

    return new Promise<ProbeOutcome>((resolve) => {
      let providerTimer: unknown;
      const duration = () => Math.max(0, this.#clock.now() - startedAt);
      const finish = (outcome: ProbeOutcome) => {
        if (token.closed) return;
        token.closed = true;
        this.#clock.clearTimeout(providerTimer);
        controller.signal.removeEventListener("abort", onAbort);
        this.#activeProbes.delete(token);
        resolve(outcome);
      };
      const discard = () => {
        if (token.discardEmitted) return;
        token.discardEmitted = true;
        this.#emit({
          version: 1,
          type: "inspection-discarded",
          backendId: target.connection.backendId,
          generation,
          reason: "stale-generation",
        });
      };
      const onAbort = () => {
        const reason = controller.signal.reason;
        if (token.superseded) {
          discard();
          finish({ kind: "stale", target, token, durationMs: duration() });
          return;
        }
        if (reason instanceof ProviderInspectionTimeoutError) {
          finish({
            kind: "timeout",
            target,
            token,
            durationMs: duration(),
            inspection: syntheticInspection(target, generation, this.#clock.now()),
          });
          return;
        }
        finish({ kind: "cancelled", target, token, durationMs: duration() });
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });

      const request = {
        connectionId: target.connection.id,
        generation,
        deadlineAt,
        signal: controller.signal,
      };
      const operation = Promise.resolve().then(() => target.adapter[method](request));
      operation.then(
        (raw) => {
          if (token.closed) {
            discard();
            return;
          }
          if (generation !== this.#generation) {
            discard();
            finish({ kind: "stale", target, token, durationMs: duration() });
            return;
          }
          let normalized: NormalizedInspection | null = null;
          try {
            normalized = normalizeInspection(raw, target, generation);
          } catch {
            // Treat adversarial getters like any other invalid adapter result.
          }
          if (!normalized) {
            finish({ kind: "invalid", target, token, durationMs: duration() });
            return;
          }
          finish({
            kind: "completed",
            target,
            token,
            durationMs: duration(),
            inspection: normalized,
          });
        },
        () => {
          if (token.closed) {
            discard();
            return;
          }
          if (controller.signal.aborted) {
            onAbort();
            return;
          }
          finish({
            kind: "error",
            target,
            token,
            durationMs: duration(),
            inspection: syntheticInspection(target, generation, this.#clock.now()),
          });
        },
      );

      providerTimer = this.#clock.setTimeout(() => {
        controller.abort(new ProviderInspectionTimeoutError(
          "provider",
          target.connection.backendId,
          timeoutMs,
        ));
      }, timeoutMs);
    });
  }

  #invalidateGeneration(generation: number, outcomes: readonly ProbeOutcome[]): void {
    if (generation === this.#generation) this.#generation += 1;
    this.#proofs.clear();
    for (const outcome of outcomes) {
      if (outcome.kind === "stale" || outcome.kind === "cancelled") continue;
      if (outcome.token.discardEmitted) continue;
      outcome.token.discardEmitted = true;
      this.#emit({
        version: 1,
        type: "inspection-discarded",
        backendId: outcome.target.connection.backendId,
        generation,
        reason: "stale-generation",
      });
    }
  }

  #publishInspectionEvents(
    outcomes: readonly ProbeOutcome[],
    state: ProviderSetupStateV2,
    generationToken: GenerationToken,
  ): boolean {
    const generation = generationToken.generation;
    for (const outcome of outcomes) {
      if (outcome.kind === "invalid") {
        if (!this.#emitForGeneration(generationToken, {
          version: 1,
          type: "terminal-failure",
          backendId: outcome.target.connection.backendId,
          generation,
          code: "provider-inspection-invalid",
          retryable: true,
          message: "Provider inspection returned invalid metadata.",
        })) return false;
        continue;
      }
      if (
        outcome.kind !== "completed"
        && outcome.kind !== "timeout"
        && outcome.kind !== "error"
      ) continue;
      const connection = state.connections.find((candidate) =>
        candidate.id === outcome.target.connection.id
        && candidate.backendId === outcome.target.connection.backendId
      );
      const accountFingerprint = outcome.inspection.accountFingerprint
        ?? (connection?.accountFingerprintState === "verified"
          ? connection.accountFingerprint
          : null);
      if (!this.#emitForGeneration(generationToken, {
        version: 1,
        type: "inspection-end",
        backendId: outcome.inspection.backendId,
        maturity: outcome.target.maturity,
        generation,
        durationMs: outcome.durationMs,
        health: structuredClone(outcome.inspection.health),
        headline: outcome.inspection.headline,
        accountFingerprint,
        billingRealm: outcome.inspection.billingRealm,
      })) return false;
      if (outcome.inspection.headline === "ready" && outcome.inspection.routeEligible) continue;
      if (outcome.inspection.health.credential === "rejected") {
        if (!this.#emitForGeneration(generationToken, {
          version: 1,
          type: "terminal-failure",
          backendId: outcome.inspection.backendId,
          generation,
          code: "provider-auth-replacement-required",
          retryable: false,
          message: "Provider credential replacement is required.",
        })) return false;
      } else {
        if (!this.#emitForGeneration(generationToken, {
          version: 1,
          type: "warning",
          generation,
          code: "provider-inspection-retryable",
          message: "Provider inspection can be retried.",
        })) return false;
      }
    }
    return this.#ownsGeneration(generationToken);
  }

  #recordProofs(
    outcomes: readonly ProbeOutcome[],
    state: ProviderSetupStateV2,
    generation: number,
  ): void {
    for (const outcome of outcomes) {
      if (outcome.kind !== "completed") continue;
      const inspection = outcome.inspection;
      if (
        inspection.headline !== "ready"
        || !inspection.routeEligible
        || !inspection.accountFingerprint
      ) continue;
      const connection = state.connections.find((candidate) =>
        candidate.enabled
        && candidate.accountFingerprintState === "verified"
        && candidate.id === inspection.connectionId
        && candidate.backendId === inspection.backendId
        && candidate.accountFingerprint === inspection.accountFingerprint
        && candidate.billingRealm === inspection.billingRealm
      );
      if (!connection) continue;
      this.#proofs.set(connection.id, {
        generation,
        stateRevision: state.revision,
        backendId: connection.backendId,
        connectionId: connection.id,
        accountFingerprint: connection.accountFingerprint,
        billingRealm: connection.billingRealm,
      });
    }
  }

  #reduce(
    state: ProviderSetupStateV2,
    generation: number,
    outcomes: readonly ProbeOutcome[],
  ): StartupSetupResult {
    const configuredRoutes = uniqueRoutes([
      state.defaultRoute,
      state.cross.preferredLead,
      state.cross.preferredChallenger,
    ]);
    const candidates = uniqueRoutes([
      ...state.connections.flatMap((connection) =>
        configuredRoutes.filter((route) =>
          route.backendId === connection.backendId
          && route.accountFingerprint === connection.accountFingerprint
          && route.billingRealm === connection.billingRealm
        )
      ),
      ...configuredRoutes,
    ]);
    const readyRoutes = candidates.filter((candidate) =>
      isResolvedRoute(candidate) && this.#routeHasProof(candidate, state, generation)
    );
    const defaultReady = state.defaultRoute !== null
      && isResolvedRoute(state.defaultRoute)
      && readyRoutes.some((candidate) => sameResolvedRoute(candidate, state.defaultRoute!));
    const unresolvedDefaultHealthy = state.defaultRoute?.resolutionState === "legacy-unverified"
      && this.#routeHasProof(state.defaultRoute, state, generation);
    const degraded = outcomes.some((outcome) =>
      outcome.kind === "invalid"
      || outcome.kind === "timeout"
      || outcome.kind === "error"
      || (outcome.kind === "completed"
        && (outcome.inspection.headline !== "ready" || !outcome.inspection.routeEligible))
    );
    const authReplacementRequired = outcomes.some((outcome) =>
      outcome.kind === "completed"
      && outcome.inspection.health.credential === "rejected"
    );
    let mode: StartupSetupMode;
    if (defaultReady) mode = degraded ? "ready-with-warning" : "ready";
    else if (readyRoutes.length > 0 || unresolvedDefaultHealthy) mode = "route-choice-required";
    else mode = "setup-required";
    const warnings = degraded
      ? [authReplacementRequired
        ? "Provider credential replacement is required."
        : "Provider inspection can be retried."]
      : [];
    return freezeResult({
      mode,
      generation,
      defaultRoute: state.defaultRoute ? structuredClone(state.defaultRoute) : null,
      readyRoutes: structuredClone(readyRoutes),
      warnings,
      crossEnabled: false,
    });
  }

  #routeHasProof(
    route: RouteIdentityV1,
    state: ProviderSetupStateV2,
    generation: number,
  ): boolean {
    const connections = state.connections.filter((candidate) =>
      candidate.enabled
      && candidate.accountFingerprintState === "verified"
      && candidate.backendId === route.backendId
      && candidate.accountFingerprint === route.accountFingerprint
      && candidate.billingRealm === route.billingRealm
    );
    if (connections.length !== 1) return false;
    const connection = connections[0]!;
    const proof = this.#proofs.get(connection.id);
    return proof?.generation === generation
      && proof.stateRevision === state.revision
      && proof.backendId === route.backendId
      && proof.accountFingerprint === route.accountFingerprint
      && proof.billingRealm === route.billingRealm;
  }

  #publishModeEvent(result: StartupSetupResult, unresolved: RouteIdentityV1 | null): void {
    if (result.mode === "route-choice-required") {
      const routes = result.readyRoutes.length > 0
        ? result.readyRoutes
        : unresolved ? [unresolved] : [];
      this.#emit({
        version: 1,
        type: "route-choice-required",
        generation: result.generation,
        routeIds: routes.map(routeId),
      });
    } else if (result.mode === "setup-required") {
      this.#emit({ version: 1, type: "setup-required", generation: result.generation });
    }
  }

  #publishRouteChoice(
    state: ProviderSetupStateV2,
    generation: number,
    route: RouteIdentityV1,
  ): StartupSetupResult {
    const result = freezeResult({
      mode: "route-choice-required",
      generation,
      defaultRoute: state.defaultRoute ? structuredClone(state.defaultRoute) : null,
      readyRoutes: [],
      warnings: [],
      crossEnabled: false,
    });
    this.#latestResult = result;
    this.#emit({
      version: 1,
      type: "route-choice-required",
      generation,
      routeIds: [routeId(route)],
    });
    return result;
  }

  #setupRequiredResult(
    state: ProviderSetupStateV2,
    generation: number,
  ): StartupSetupResult {
    return freezeResult({
      mode: "setup-required",
      generation,
      defaultRoute: state.defaultRoute ? structuredClone(state.defaultRoute) : null,
      readyRoutes: [],
      warnings: [],
      crossEnabled: false,
    });
  }

  async #handleCallerCancellation(
    captured: ProviderSetupStateV2,
    generationToken: GenerationToken,
    signal: AbortSignal,
  ): Promise<never> {
    const generation = generationToken.generation;
    if (this.#ownsGeneration(generationToken)) {
      const state = await this.#commitCancelled(captured, generation);
      if (!this.#ownsGeneration(generationToken)) throw abortReason(signal);
      const result = this.#setupRequiredResult(state, generation);
      this.#latestResult = result;
      this.#proofs.clear();
      this.#emit({ version: 1, type: "setup-required", generation });
    }
    throw abortReason(signal);
  }

  async #handleLegacyCallerCancellation(
    captured: ProviderSetupStateV2,
    generation: number,
    signal: AbortSignal,
  ): Promise<never> {
    if (generation === this.#generation) {
      const state = await this.#commitCancelled(captured, generation);
      if (generation === this.#generation) {
        const result = this.#setupRequiredResult(state, generation);
        this.#latestResult = result;
        this.#proofs.clear();
      }
    }
    throw abortReason(signal);
  }

  async #commitCancelled(
    captured: ProviderSetupStateV2,
    generation: number,
  ): Promise<ProviderSetupStateV2> {
    try {
      return await this.#stateStore.commit(
        captured.revision,
        (current) => {
          if (JSON.stringify(current) !== JSON.stringify(captured)) {
            throw new Error("Provider state changed before setup cancellation.");
          }
          return {
            ...current,
            lifecycle: "cancelled",
            cross: {
              enabled: false,
              preferredLead: current.cross.preferredLead,
              preferredChallenger: current.cross.preferredChallenger,
            },
          };
        },
        () => {
          if (generation !== this.#generation) {
            throw new Error("Setup cancellation generation is stale.");
          }
        },
      );
    } catch (error) {
      const committed = readProviderStateCommitAdoption(error);
      if (
        committed
        && committed.revision === captured.revision + 1
        && committed.lifecycle === "cancelled"
      ) {
        return committed;
      }
      throw error;
    }
  }

  #listModelsBounded(
    adapter: BackendAdapter,
    connectionId: string,
    generation: number,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<BoundedModelsResult> {
    if (callerSignal?.aborted) return Promise.resolve({ kind: "cancelled" });
    const controller = new AbortController();
    const token: AttemptToken = {
      generation,
      backendId: adapter.backendId,
      connectionId,
      controller,
      closed: false,
      superseded: false,
      discardEmitted: false,
    };
    this.#activeProbes.add(token);
    return new Promise<BoundedModelsResult>((resolve) => {
      let timer: unknown;
      const finish = (result: BoundedModelsResult) => {
        if (token.closed) return;
        token.closed = true;
        this.#clock.clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        callerSignal?.removeEventListener("abort", onCallerAbort);
        this.#activeProbes.delete(token);
        resolve(result);
      };
      const onAbort = () => {
        if (token.superseded || generation !== this.#generation) finish({ kind: "stale" });
        else if (callerSignal?.aborted) finish({ kind: "cancelled" });
        else finish({ kind: "timeout" });
      };
      const onCallerAbort = () => controller.abort(abortReason(callerSignal!));
      timer = this.#clock.setTimeout(() => {
        controller.abort(new ProviderInspectionTimeoutError(
          "provider",
          adapter.backendId,
          timeoutMs,
        ));
      }, timeoutMs);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      if (callerSignal?.aborted) {
        onCallerAbort();
        return;
      }
      const operation = Promise.resolve().then(() =>
        adapter.listModels({
          connectionId: token.connectionId,
          signal: controller.signal,
        })
      );
      operation.then(
        (models) => {
          if (token.closed) return;
          if (generation !== this.#generation) finish({ kind: "stale" });
          else {
            let normalized: readonly BackendModelDescriptor[] | null = null;
            try {
              normalized = normalizeModelList(models);
            } catch {
              // Treat adversarial getters like any other invalid catalog result.
            }
            finish(normalized
              ? { kind: "models", models: normalized }
              : { kind: "error" });
          }
        },
        () => {
          if (token.closed) return;
          if (controller.signal.aborted) onAbort();
          else finish({ kind: "error" });
        },
      );
    });
  }

  #emit(event: SetupEvent): void {
    this.#emitCallback(deepFreeze(structuredClone(event)));
  }

  #emitForGeneration(token: GenerationToken, event: SetupEvent): boolean {
    if (!this.#ownsGeneration(token)) return false;
    this.#emit(event);
    return this.#ownsGeneration(token);
  }
}

function applyOutcomes(
  state: ProviderSetupStateV2,
  outcomes: readonly ProbeOutcome[],
): ApplyResult {
  const next = structuredClone(state);
  let changed = false;
  for (const outcome of outcomes) {
    if (
      outcome.kind !== "completed"
      && outcome.kind !== "timeout"
      && outcome.kind !== "error"
    ) continue;
    const index = next.connections.findIndex((candidate) =>
      candidate.id === outcome.target.connection.id
      && candidate.backendId === outcome.target.connection.backendId
    );
    if (index < 0) continue;
    const current = next.connections[index]!;
    const inspected = outcome.inspection;
    if (current.accountFingerprintState === "provisional") {
      if (
        outcome.kind !== "completed"
        || inspected.headline !== "ready"
        || !inspected.routeEligible
        || !inspected.accountFingerprint
        || inspected.billingRealm !== current.billingRealm
      ) continue;
      const oldFingerprint = current.accountFingerprint;
      current.accountFingerprint = inspected.accountFingerprint;
      current.accountFingerprintState = "verified";
      current.lastHealth = structuredClone(inspected.health);
      next.defaultRoute = rewriteFingerprint(
        next.defaultRoute,
        current,
        oldFingerprint,
      );
      next.cross.preferredLead = rewriteFingerprint(
        next.cross.preferredLead,
        current,
        oldFingerprint,
      );
      next.cross.preferredChallenger = rewriteFingerprint(
        next.cross.preferredChallenger,
        current,
        oldFingerprint,
      );
      changed = true;
      continue;
    }
    if (
      outcome.kind === "completed"
      && inspected.headline === "ready"
      && inspected.accountFingerprint !== current.accountFingerprint
    ) continue;
    current.lastHealth = structuredClone(inspected.health);
    changed = true;
  }
  return { state: next, changed };
}

function rewriteFingerprint(
  route: RouteIdentityV1 | null,
  connection: ProviderConnectionStateV1,
  oldFingerprint: string,
): RouteIdentityV1 | null {
  if (
    !route
    || route.backendId !== connection.backendId
    || route.accountFingerprint !== oldFingerprint
    || route.billingRealm !== connection.billingRealm
  ) return route;
  return {
    ...route,
    accountFingerprint: connection.accountFingerprint,
  };
}

function normalizeInspection(
  raw: unknown,
  target: ProbeTarget,
  generation: number,
): NormalizedInspection | null {
  if (!isRecord(raw)) return null;
  let backendId: unknown;
  let connectionId: unknown;
  let healthValue: unknown;
  let accountFingerprint: unknown;
  let billingRealm: unknown;
  try {
    backendId = raw.backendId;
    connectionId = raw.connectionId;
    healthValue = raw.health;
    accountFingerprint = raw.accountFingerprint;
    billingRealm = raw.billingRealm;
  } catch {
    return null;
  }
  if (!isRecord(healthValue)) return null;
  let credential: unknown;
  let connectivity: unknown;
  let spend: unknown;
  let runtime: unknown;
  let observedAt: unknown;
  let healthGeneration: unknown;
  try {
    credential = healthValue.credential;
    connectivity = healthValue.connectivity;
    spend = healthValue.spend;
    runtime = healthValue.runtime;
    observedAt = healthValue.observedAt;
    healthGeneration = healthValue.generation;
  } catch {
    return null;
  }
  const healthSnapshot = {
    credential,
    connectivity,
    spend,
    runtime,
    observedAt,
    generation: healthGeneration,
  };
  if (
    backendId !== target.connection.backendId
    || connectionId !== target.connection.id
    || billingRealm !== target.connection.billingRealm
    || !validHealth(healthSnapshot, generation)
    || !(accountFingerprint === null
      || (typeof accountFingerprint === "string" && accountFingerprint.length > 0))
    || (target.connection.accountFingerprintState === "verified"
      && accountFingerprint !== null
      && accountFingerprint !== target.connection.accountFingerprint)
  ) return null;
  const health: ProviderHealth = {
    credential: healthSnapshot.credential,
    connectivity: healthSnapshot.connectivity,
    spend: healthSnapshot.spend,
    runtime: healthSnapshot.runtime,
    observedAt: healthSnapshot.observedAt,
    generation: healthSnapshot.generation,
  };
  const headline = deriveProviderHeadline(health);
  const fingerprintEligible = accountFingerprint !== null
    && (target.connection.accountFingerprintState === "verified"
      || accountFingerprint !== target.connection.accountFingerprint);
  return {
    backendId: target.connection.backendId,
    connectionId: target.connection.id,
    health,
    headline,
    accountFingerprint,
    billingRealm: target.connection.billingRealm,
    routeEligible: headline === "ready" && fingerprintEligible,
  };
}

function syntheticInspection(
  target: ProbeTarget,
  generation: number,
  observedAt: number,
): NormalizedInspection {
  assertFiniteNow(observedAt);
  const health: ProviderHealth = {
    credential: "unknown",
    connectivity: "unknown",
    spend: "unknown",
    runtime: "not-applicable",
    observedAt,
    generation,
  };
  return {
    backendId: target.connection.backendId,
    connectionId: target.connection.id,
    health,
    headline: "unknown",
    accountFingerprint: null,
    billingRealm: target.connection.billingRealm,
    routeEligible: false,
  };
}

function validHealth(value: unknown, generation: number): value is ProviderHealth {
  if (!isRecord(value)) return false;
  return includes([
    "valid", "rejected", "expired", "login-required", "unknown", "not-applicable",
  ] as const, value.credential)
    && includes(["connected", "offline", "unknown"] as const, value.connectivity)
    && includes(["available", "limit-reached", "unknown"] as const, value.spend)
    && includes([
      "ready", "missing", "incompatible", "policy-unavailable", "not-applicable",
    ] as const, value.runtime)
    && Number.isFinite(value.observedAt)
    && Number.isInteger(value.generation)
    && value.generation === generation;
}

function normalizeModelList(value: unknown): readonly BackendModelDescriptor[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: BackendModelDescriptor[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    let backendId: unknown;
    let requestedModelId: unknown;
    let canonicalModelId: unknown;
    let displayName: unknown;
    let capabilities: unknown;
    try {
      backendId = candidate.backendId;
      requestedModelId = candidate.requestedModelId;
      canonicalModelId = candidate.canonicalModelId;
      displayName = candidate.displayName;
      capabilities = candidate.capabilities;
    } catch {
      return null;
    }
    if (!isRecord(capabilities)) continue;
    let textInput: unknown;
    let textOutput: unknown;
    let tools: unknown;
    let reasoning: unknown;
    try {
      textInput = capabilities.textInput;
      textOutput = capabilities.textOutput;
      tools = capabilities.tools;
      reasoning = capabilities.reasoning;
    } catch {
      return null;
    }
    if (
      !includes(["openrouter", "codex", "anthropic"] as const, backendId)
      || typeof requestedModelId !== "string"
      || requestedModelId.length === 0
      || typeof canonicalModelId !== "string"
      || canonicalModelId.length === 0
      || typeof textInput !== "boolean"
      || typeof textOutput !== "boolean"
      || typeof tools !== "boolean"
      || typeof reasoning !== "boolean"
    ) continue;
    normalized.push({
      backendId,
      requestedModelId,
      canonicalModelId,
      displayName: typeof displayName === "string" ? displayName : "",
      capabilities: {
        textInput,
        textOutput,
        tools,
        reasoning,
      },
    });
  }
  return normalized;
}

function safeRouteIdentity(value: unknown): RouteIdentityV1 | null {
  if (!isRecord(value)) return null;
  let version: unknown;
  let backendId: unknown;
  let accountFingerprint: unknown;
  let billingRealm: unknown;
  let requestedModelId: unknown;
  let canonicalModelId: unknown;
  let resolutionState: unknown;
  try {
    version = value.version;
    backendId = value.backendId;
    accountFingerprint = value.accountFingerprint;
    billingRealm = value.billingRealm;
    requestedModelId = value.requestedModelId;
    canonicalModelId = value.canonicalModelId;
    resolutionState = value.resolutionState;
  } catch {
    return null;
  }
  if (
    version !== 1
    || !includes(["openrouter", "codex", "anthropic"] as const, backendId)
    || typeof accountFingerprint !== "string"
    || accountFingerprint.length === 0
    || !includes([
      "openrouter-payg",
      "chatgpt-subscription-provider-managed-overage",
      "chatgpt-account-provider-managed-limits",
      "none",
    ] as const, billingRealm)
    || typeof requestedModelId !== "string"
    || requestedModelId.length === 0
    || !includes(["legacy-unverified", "resolved"] as const, resolutionState)
    || (resolutionState === "resolved"
      ? typeof canonicalModelId !== "string" || canonicalModelId.length === 0
      : canonicalModelId !== null)
  ) return null;
  const safeCanonicalModelId = resolutionState === "resolved"
    ? canonicalModelId as string
    : null;
  return {
    version: 1,
    backendId,
    accountFingerprint,
    billingRealm,
    requestedModelId,
    canonicalModelId: safeCanonicalModelId,
    resolutionState,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedTimeout(
  requested: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const value = requested ?? fallback;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Provider ${label} timeout is invalid.`);
  }
  return Math.min(value, maximum);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Provider setup cancelled.", "AbortError");
}

function assertFiniteNow(value: number): void {
  if (!Number.isFinite(value)) throw new Error("Setup clock returned an invalid time.");
}

function routeId(route: RouteIdentityV1): string {
  return JSON.stringify({
    version: route.version,
    backendId: route.backendId,
    accountFingerprint: route.accountFingerprint,
    billingRealm: route.billingRealm,
    requestedModelId: route.requestedModelId,
    canonicalModelId: route.canonicalModelId,
    resolutionState: route.resolutionState,
  });
}

function uniqueRoutes(
  routes: readonly (RouteIdentityV1 | null)[],
): RouteIdentityV1[] {
  const seen = new Set<string>();
  const result: RouteIdentityV1[] = [];
  for (const route of routes) {
    if (!route) continue;
    const id = routeId(route);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(structuredClone(route));
  }
  return result;
}

function isResolvedRoute(route: RouteIdentityV1): boolean {
  return route.resolutionState === "resolved"
    && typeof route.canonicalModelId === "string"
    && route.canonicalModelId.length > 0;
}

function sameResolvedRoute(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return isResolvedRoute(left)
    && isResolvedRoute(right)
    && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.canonicalModelId === right.canonicalModelId;
}

function freezeResult(result: StartupSetupResult): StartupSetupResult {
  return deepFreeze(structuredClone(result));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}
