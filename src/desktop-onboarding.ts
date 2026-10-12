import { randomUUID } from "node:crypto";

import type {
  DesktopCapabilitySnapshot,
  DesktopDisabledPresentation,
  DesktopOnboardingIntent,
  DesktopOnboardingResult,
  DesktopOnboardingView,
  DesktopProviderCapability,
  DesktopRouteCandidate,
} from "./desktop-contracts.js";
import type { RoutePickerSelectionIntent } from "./route-picker.js";
import { DESKTOP_DISABLED_COPY } from "./desktop-german-copy.js";

const ROUTE_UNAVAILABLE: DesktopDisabledPresentation = Object.freeze({
  code: "route-stale",
  label: "Die gewählte Modellroute ist nicht verfügbar.",
  recoveryLabel: "Aktualisieren und erneut auswählen",
});

/** Shared opaque namespace for controller-owned and server-owned setup work. */
export function createDesktopOnboardingOperationHandle(): string {
  return `desktop-onboarding:${randomUUID()}`;
}

/** The only activation facts the controller may pass to the core authority. */
export interface DesktopOnboardingActivation extends Omit<RoutePickerSelectionIntent, "handle"> {
  readonly routeHandle: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly revision: number;
  readonly generation: number;
}

/** Secretless proof returned after the authority accepted one exact route. */
export interface DesktopOnboardingActivationResult {
  readonly routeHandle: string;
  readonly revision: number;
  readonly generation: number;
}

export interface DesktopOnboardingAccountRefresh {
  readonly providerId: string;
  readonly connectionId: string;
  readonly revision: number;
  readonly generation: number;
}

/**
 * The sole core-facing port for the desktop reducer. Its implementation owns
 * private route resolution, credentials, activation and exact-route proof.
 */
export interface DesktopOnboardingAuthority {
  snapshot(): DesktopCapabilitySnapshot;
  refreshAccount(selection: DesktopOnboardingAccountRefresh, signal?: AbortSignal): Promise<DesktopCapabilitySnapshot>;
  cancelActivation(): Promise<"cancelled" | "completion-committed" | "none">;
  activate(selection: DesktopOnboardingActivation, signal?: AbortSignal): Promise<DesktopOnboardingActivationResult>;
}

export interface DesktopOnboardingControllerOptions {
  readonly authority: DesktopOnboardingAuthority;
}

/**
 * Secretless, revision-bound state reducer for the Desktop setup flow.
 * Provider mutations remain in SetupOrchestrator; this controller only
 * resolves an already opaque choice and requires that authority to accept the
 * exact completed route before it reports readiness.
 */
export class DesktopOnboardingController {
  readonly #authority: DesktopOnboardingAuthority;
  #view: DesktopOnboardingView;
  #providerId: string | undefined;
  #connectionId: string | undefined;
  #activationInFlight = false;
  #activationEpoch = 0;
  #navigationEpoch = 0;
  #retryRouteHandle: string | undefined;
  #activeOperation: {
    readonly token: symbol;
    readonly handle: string;
    readonly revision: number;
    readonly generation: number;
  } | null = null;

  constructor(options: DesktopOnboardingControllerOptions) {
    this.#authority = options.authority;
    const snapshot = options.authority.snapshot();
    this.#view = viewFor(snapshot, snapshot.routeRunnable ? "ready" : "provider", "chat");
  }

  snapshot(): DesktopOnboardingView {
    const view = structuredClone(this.#view);
    return this.#activeOperation
      ? { ...view, operationHandle: this.#activeOperation.handle }
      : view;
  }

  /** Opaque retry identity for the process-local owner of this controller. */
  retryRouteHandle(): string | null {
    if (this.#view.step !== "error" || !this.#retryRouteHandle) return null;
    return this.#view.candidates.some((candidate) => candidate.handle === this.#retryRouteHandle)
      ? this.#retryRouteHandle
      : null;
  }

  async dispatch(
    intent: DesktopOnboardingIntent,
    signal?: AbortSignal,
    operationHandle?: string,
  ): Promise<DesktopOnboardingResult> {
    if (intent.kind === "cancel") {
      // Cancellation must observe an in-flight durable outcome even if that
      // outcome already advanced the public epoch before its promise settled.
      return this.#cancel(this.#snapshotForCancel(
        intent.revision,
        intent.generation,
        intent.operationHandle,
      ));
    }
    const snapshot = this.#assertCurrent(intent.revision, intent.generation);
    switch (intent.kind) {
      case "open-model-picker":
        this.#navigationEpoch += 1;
        this.#retryRouteHandle = undefined;
        this.#providerId = undefined;
        this.#connectionId = undefined;
        this.#view = viewFor(
          snapshot,
          snapshot.routeRunnable ? "model" : "provider",
          intent.returnTo,
          undefined,
          undefined,
          snapshot.routeRunnable ? allRoutes(snapshot) : [],
        );
        return this.#viewResult();
      case "choose-provider":
        return this.#chooseProvider(snapshot, intent.providerId);
      case "choose-account":
        return this.#chooseAccount(snapshot, intent.connectionId, signal, operationHandle);
      case "choose-model":
        return this.#activateExplicitCandidate(snapshot, intent.routeHandle, signal, operationHandle);
      case "retry":
        return this.#view.step === "error" && this.#retryRouteHandle
          ? this.#activateExplicitCandidate(snapshot, this.#retryRouteHandle, signal, operationHandle)
          : this.#viewResult();
      case "back":
        return this.#back(snapshot);
    }
  }

  #chooseProvider(
    snapshot: DesktopCapabilitySnapshot,
    providerId: string,
  ): DesktopOnboardingResult {
    const providers = providersFor(snapshot, providerId);
    if (providers.length === 0 || !providers.some(isAvailableProvider)) {
      throw new Error("The selected provider is unavailable.");
    }
    this.#navigationEpoch += 1;
    this.#retryRouteHandle = undefined;
    this.#providerId = providerId;
    this.#connectionId = undefined;
    this.#view = viewFor(snapshot, "account", this.#view.returnTo, providerId);
    return this.#viewResult();
  }

  async #chooseAccount(
    snapshot: DesktopCapabilitySnapshot,
    connectionId: string,
    signal?: AbortSignal,
    operationHandle?: string,
  ): Promise<DesktopOnboardingResult> {
    throwIfAborted(signal);
    const navigationEpoch = ++this.#navigationEpoch;
    const providers = this.#selectedProviders(snapshot);
    let current = snapshot;
    let candidates = providers.flatMap((provider) => provider.routes)
      .filter((candidate) => candidate.connectionId === connectionId);
    const account = providers.find((provider) => provider.connectionId === connectionId);
    if (!account || !isAvailableProvider(account)) throw new Error("The selected account is unavailable.");
    const operationToken = this.#beginOperation(snapshot, operationHandle);
    try {
      current = await this.#authority.refreshAccount({
        providerId: this.#providerId!, connectionId, revision: snapshot.revision, generation: snapshot.generation,
      }, signal);
      throwIfAborted(signal);
      if (navigationEpoch !== this.#navigationEpoch) {
        throw new Error("The setup selection was cancelled.");
      }
      if (current.revision !== snapshot.revision || current.generation !== snapshot.generation) {
        throw new Error("The setup selection is stale. Refresh and try again.");
      }
      candidates = providersFor(current, this.#providerId!).flatMap((provider) => provider.routes)
        .filter((candidate) => candidate.connectionId === connectionId);
      if (candidates.length === 0) throw new Error("The selected account is unavailable.");
      this.#connectionId = connectionId;
      this.#retryRouteHandle = undefined;
      this.#view = viewFor(
        current,
        "model",
        this.#view.returnTo,
        this.#providerId,
        connectionId,
        candidates,
      );
      return this.#viewResult();
    } finally {
      this.#endOperation(operationToken);
    }
  }

  async #activateExplicitCandidate(
    snapshot: DesktopCapabilitySnapshot,
    routeHandle: string,
    signal?: AbortSignal,
    operationHandle?: string,
  ): Promise<DesktopOnboardingResult> {
    if (this.#activationInFlight) throw new Error("The setup selection is busy. Wait for it to finish.");
    const candidate = this.#selectedCandidate(snapshot, routeHandle);
    const captured = { revision: snapshot.revision, generation: snapshot.generation };
    const activationEpoch = ++this.#activationEpoch;
    const operationToken = this.#beginOperation(snapshot, operationHandle);
    this.#retryRouteHandle = routeHandle;
    this.#activationInFlight = true;
    try {
      let activation: DesktopOnboardingActivationResult;
      try {
        activation = await this.#authority.activate({
          routeHandle: candidate.handle,
          providerId: candidate.providerId,
          connectionId: candidate.connectionId,
          revision: captured.revision,
          generation: captured.generation,
        }, signal);
      } catch (error) {
        if (activationEpoch !== this.#activationEpoch || signal?.aborted) throw error;
        const current = this.#authority.snapshot();
        if (current.revision !== captured.revision || current.generation !== captured.generation) {
          throw new Error("The setup selection is stale. Refresh and try again.");
        }
        this.#view = {
          ...viewFor(
            current,
            "error",
            this.#view.returnTo,
            this.#providerId,
            this.#connectionId,
            this.#view.candidates,
          ),
          error: DESKTOP_DISABLED_COPY["route-activation-failed"],
        };
        return this.#viewResult();
      }
      if (activationEpoch !== this.#activationEpoch) {
        throw new Error("The setup selection was cancelled.");
      }
      const afterActivation = this.#authority.snapshot();
      const committedExactRoute = activation.revision > captured.revision
        && activation.generation > captured.generation
        && afterActivation.revision === activation.revision
        && afterActivation.generation === activation.generation
        && afterActivation.routeRunnable
        && activeRouteMatches(afterActivation, candidate, activation.routeHandle);
      if (!committedExactRoute) {
        throw new Error("The selected route is stale. Refresh and select it again.");
      }
      if (activationEpoch !== this.#activationEpoch) {
        throw new Error("The setup selection was cancelled.");
      }
      this.#view = viewFor(afterActivation, "ready", this.#view.returnTo);
      this.#retryRouteHandle = undefined;
      return { kind: "ready", routeHandle: activation.routeHandle, routeRunnable: true };
    } finally {
      this.#activationInFlight = false;
      this.#endOperation(operationToken);
    }
  }

  #selectedCandidate(snapshot: DesktopCapabilitySnapshot, routeHandle: string): DesktopRouteCandidate {
    const candidates = this.#view.step === "model" || this.#view.step === "error" ? this.#view.candidates : [];
    const candidate = candidates.find((value) => value.handle === routeHandle);
    if (!candidate || !candidate.runnable || candidate.disabled) {
      throw new Error("The selected route is unavailable.");
    }
    if (this.#providerId && candidate.providerId !== this.#providerId) {
      throw new Error("The selected route is unavailable.");
    }
    if (this.#connectionId && candidate.connectionId !== this.#connectionId) {
      throw new Error("The selected route is unavailable.");
    }
    if (!allRoutes(snapshot).some((value) => sameCandidate(value, candidate))) {
      throw new Error("The selected route is unavailable.");
    }
    return candidate;
  }

  #selectedProviders(snapshot: DesktopCapabilitySnapshot): readonly DesktopProviderCapability[] {
    const providers = providersFor(snapshot, this.#providerId);
    if (providers.length === 0 || !providers.some(isAvailableProvider)) {
      throw new Error("The selected provider is unavailable.");
    }
    return providers;
  }

  #back(snapshot: DesktopCapabilitySnapshot): DesktopOnboardingResult {
    this.#navigationEpoch += 1;
    this.#retryRouteHandle = undefined;
    if (this.#view.step === "error" && this.#providerId && this.#connectionId) {
      this.#view = viewFor(
        snapshot,
        "model",
        this.#view.returnTo,
        this.#providerId,
        this.#connectionId,
        this.#view.candidates,
      );
    } else if (this.#view.step === "model" && this.#providerId && this.#connectionId) {
      this.#connectionId = undefined;
      this.#view = viewFor(snapshot, "account", this.#view.returnTo, this.#providerId);
    } else if (this.#view.step === "model") {
      this.#providerId = undefined;
      this.#connectionId = undefined;
      this.#view = viewFor(snapshot, "provider", this.#view.returnTo);
    } else if (this.#view.step === "account") {
      this.#providerId = undefined;
      this.#view = viewFor(snapshot, "provider", this.#view.returnTo);
    }
    return this.#viewResult();
  }

  async #cancel(snapshot: DesktopCapabilitySnapshot): Promise<DesktopOnboardingResult> {
    const cancellation = await this.#authority.cancelActivation();
    if (cancellation === "completion-committed") {
      throw new Error("The selected route was already committed. Wait for completion.");
    }
    this.#activationEpoch += 1;
    this.#navigationEpoch += 1;
    this.#providerId = undefined;
    this.#connectionId = undefined;
    this.#retryRouteHandle = undefined;
    const step = !snapshot.routeRunnable
      ? "provider"
      : this.#view.returnTo === "model-picker" ? "model" : "ready";
    this.#view = viewFor(
      snapshot,
      step,
      this.#view.returnTo,
      undefined,
      undefined,
      step === "model" ? allRoutes(snapshot) : undefined,
    );
    return { kind: "cancelled", view: structuredClone(this.#view) };
  }

  #assertCurrent(revision: number, generation: number): DesktopCapabilitySnapshot {
    const snapshot = this.#authority.snapshot();
    if (snapshot.revision !== revision || snapshot.generation !== generation) {
      throw new Error("The setup selection is stale. Refresh and try again.");
    }
    if (this.#view.revision !== revision || this.#view.generation !== generation) {
      this.#view = viewFor(snapshot, snapshot.routeRunnable ? "ready" : "provider", this.#view.returnTo);
    }
    return snapshot;
  }

  #snapshotForCancel(
    revision: number,
    generation: number,
    operationHandle: string | undefined,
  ): DesktopCapabilitySnapshot {
    const active = this.#activeOperation;
    if (active) {
      if (active.revision !== revision
        || active.generation !== generation
        || active.handle !== operationHandle) {
        throw new Error("The setup selection is stale. Refresh and try again.");
      }
      return this.#authority.snapshot();
    }
    if (operationHandle !== undefined) {
      throw new Error("The setup selection is stale. Refresh and try again.");
    }
    return this.#assertCurrent(revision, generation);
  }

  #beginOperation(snapshot: DesktopCapabilitySnapshot, handle?: string): symbol {
    const token = Symbol("desktop-onboarding-operation");
    this.#activeOperation = {
      token,
      handle: handle ?? createDesktopOnboardingOperationHandle(),
      revision: snapshot.revision,
      generation: snapshot.generation,
    };
    return token;
  }

  #endOperation(token: symbol): void {
    if (this.#activeOperation?.token === token) this.#activeOperation = null;
  }

  #viewResult(): DesktopOnboardingResult {
    // A returned view is the settled state. The live operation capability is
    // observable only through snapshot() while the operation is still active.
    return { kind: "view", view: structuredClone(this.#view) };
  }
}

function viewFor(
  snapshot: DesktopCapabilitySnapshot,
  step: DesktopOnboardingView["step"],
  returnTo: DesktopOnboardingView["returnTo"],
  providerId?: string,
  connectionId?: string,
  candidates: readonly DesktopRouteCandidate[] = [],
): DesktopOnboardingView {
  return {
    revision: snapshot.revision,
    generation: snapshot.generation,
    step,
    returnTo,
    providers: structuredClone(snapshot.providers),
    ...(providerId === undefined ? {} : { providerId }),
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(connectionId === undefined
      ? {}
      : { accountLabel: accountLabelFor(snapshot, providerId, connectionId) }),
    candidates: structuredClone(candidates),
  };
}

function accountLabelFor(
  snapshot: DesktopCapabilitySnapshot,
  providerId: string | undefined,
  connectionId: string,
): string | undefined {
  return providersFor(snapshot, providerId).flatMap((provider) => provider.routes)
    .find((route) => route.connectionId === connectionId)?.accountLabel
    ?? providersFor(snapshot, providerId).find((provider) => provider.connectionId === connectionId)?.accountLabel
    ?? undefined;
}

function providersFor(
  snapshot: DesktopCapabilitySnapshot,
  providerId: string | undefined,
): readonly DesktopProviderCapability[] {
  return providerId === undefined ? [] : snapshot.providers.filter((provider) => provider.providerId === providerId);
}

function isAvailableProvider(provider: DesktopProviderCapability): boolean {
  return !provider.disabled && provider.state !== "disabled" && provider.state !== "blocked";
}

function allRoutes(snapshot: DesktopCapabilitySnapshot): readonly DesktopRouteCandidate[] {
  return snapshot.providers.flatMap((provider) => provider.routes);
}

function sameCandidate(left: DesktopRouteCandidate, right: DesktopRouteCandidate): boolean {
  return left.handle === right.handle
    && left.providerId === right.providerId
    && left.connectionId === right.connectionId
    && left.canonicalModelId === right.canonicalModelId;
}

function activeRouteMatches(
  snapshot: DesktopCapabilitySnapshot,
  candidate: DesktopRouteCandidate,
  activatedHandle: string,
): boolean {
  const active = snapshot.providers.flatMap((provider) => provider.routes)
    .find((route) => route.handle === activatedHandle);
  return snapshot.activeRoute?.routeHandle === activatedHandle
    && active !== undefined
    && active.providerId === candidate.providerId
    && active.connectionId === candidate.connectionId
    && active.canonicalModelId === candidate.canonicalModelId
    && active.runnable
    && active.disabled === undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The setup selection was cancelled.", "AbortError");
}
