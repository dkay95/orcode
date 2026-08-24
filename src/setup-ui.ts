import { normalizeProviderSecret } from "./credentials.js";
import type {
  BackendAdapter,
  BackendDescriptor,
  BackendId,
  BackendModelDescriptor,
  BackendRegistry,
  RouteIdentityV1,
} from "./backends.js";
import { validateRouteIdentityV1, type ProviderStateStore } from "./provider-state.js";
import type {
  ProviderCandidateAuthorityLease,
  ProviderCandidateAuthorityResult,
  ProviderCandidateCredentialPermit,
} from "./provider-authority.js";
import type { SetupEvent, SetupOrchestrator } from "./setup.js";
import type { ModelInfo } from "./types.js";

export interface SetupHubEntry {
  id: string;
  label: string;
  description: string;
  disabled: boolean;
  current: boolean;
  generation: number;
}

export interface SetupSurface {
  chooseHub(entries: readonly SetupHubEntry[]): Promise<string | null>;
  readSecret(request: { backendId: BackendId; message: string }): Promise<string | null>;
  chooseModel(request: { backendId: BackendId; models: readonly BackendModelDescriptor[] }): Promise<string | null>;
  confirm(request: { id: string; message: string; defaultValue: boolean }): Promise<boolean>;
  present(event: SetupPresentation): void;
}

export interface SetupPreparedRoles {
  lead: RouteIdentityV1;
  challenger: RouteIdentityV1;
}

export interface SetupProviderStatePresentation {
  version: 1;
  type: "provider-state";
  entries: readonly SetupHubEntry[];
}

export type SetupPresentation =
  | SetupEvent
  | { version: 1; type: "notice"; message: string }
  | SetupProviderStatePresentation;

export type SetupHubResult =
  | { kind: "cancelled"; mode: "setup-required" }
  | { kind: "ready"; preparedRoles?: SetupPreparedRoles };

export interface SetupHubOptions {
  surface: SetupSurface;
  orchestrator: SetupOrchestrator;
  registry: BackendRegistry;
  stateStore: ProviderStateStore;
  /** A saved credential, if one was authoritatively loaded for this startup. */
  savedSecret?: string | null;
  /** Process-only candidate used automatically only when no saved key exists. */
  environmentSecret?: string | null;
  /** Existing whole-startup attempt. Omitted for an independent manual setup. */
  signal?: AbortSignal;
  deadlineAt?: number;
  generation?: number;
  targetConnectionId?: string;
  /** Durable revision captured with an authority-backed saved credential. */
  expectedRevision?: number;
  savedCandidatePermit?: ProviderCandidateCredentialPermit | null;
  environmentCandidatePermit?: ProviderCandidateCredentialPermit | null;
  /** Reasserts that no provider cleanup/recovery journal blocks candidate IO. */
  preflightCandidate?: () => Promise<boolean>;
  /** Holds candidate authority only across connect and catalog network effects. */
  withCandidateAuthority?: <T>(
    credentialPermit: ProviderCandidateCredentialPermit | null,
    requireCredentialPermit: boolean,
    use: (lease: ProviderCandidateAuthorityLease) => Promise<T>,
  ) => Promise<ProviderCandidateAuthorityResult<T>>;
}

/**
 * The setup controller deliberately has no terminal dependency. Both prompt
 * transports provide the same small surface, so cancellation and provider
 * boundaries cannot diverge between plain and fullscreen modes.
 */
export async function runSetupHub(options: SetupHubOptions): Promise<SetupHubResult> {
  const attempt = createSetupAttempt(options.signal, options.deadlineAt);
  try {
    return await runSetupHubAttempt({ ...options, signal: attempt.signal });
  } catch (error) {
    if (attempt.signal.aborted) {
      return { kind: "cancelled", mode: "setup-required" };
    }
    throw error;
  } finally {
    attempt.close();
  }
}

async function runSetupHubAttempt(options: SetupHubOptions): Promise<SetupHubResult> {
  const { surface, registry, orchestrator, stateStore } = options;
  const savedSecret = nonEmpty(options.savedSecret);
  let pendingEnvironment = savedSecret ? null : nonEmpty(options.environmentSecret);
  let savedAvailable = savedSecret !== null;
  let environmentOffered = false;

  while (true) {
    if (options.signal?.aborted) return { kind: "cancelled", mode: "setup-required" };
    if (pendingEnvironment) {
      const secret = pendingEnvironment;
      pendingEnvironment = null;
      const outcome = await activateOpenRouter(
        secret,
        "process-only",
        false,
        options.environmentCandidatePermit ?? null,
        true,
        options,
      );
      if (outcome.kind === "ready") {
        return completeCrossSetup(surface, registry, stateStore, outcome, options.signal!);
      }
      if (outcome.kind === "cancelled") return { kind: "cancelled", mode: "setup-required" };
      continue;
    }

    const entries = hubEntries(registry, stateStore, environmentOffered);
    const selected = await abortableSetupAction(
      () => surface.chooseHub(entries),
      options.signal!,
    );
    if (selected === null) return { kind: "cancelled", mode: "setup-required" };

    if (selected === "openrouter:environment" && environmentOffered) {
      const environment = nonEmpty(options.environmentSecret);
      if (!environment) continue;
      const outcome = await activateOpenRouter(
        environment,
        "process-only",
        false,
        options.environmentCandidatePermit ?? null,
        true,
        options,
      );
      if (outcome.kind === "ready") {
        return completeCrossSetup(surface, registry, stateStore, outcome, options.signal!);
      }
      if (outcome.kind === "cancelled") return { kind: "cancelled", mode: "setup-required" };
      continue;
    }

    const descriptor = descriptorFor(registry, selected);
    if (!descriptor) {
      surface.present(notice("Diese Auswahl ist nicht verfügbar."));
      continue;
    }
    if (!descriptor.connectable) {
      surface.present(notice(`${descriptor.displayName} ist Coming soon und kann noch nicht verbunden werden.`));
      continue;
    }

    let candidate: string | null = null;
    let persistence: "persisted" | "process-only" = "persisted";
    let askPersistence = true;
    const usingSaved = descriptor.id === "openrouter" && savedAvailable;
    if (usingSaved) {
      candidate = savedSecret;
      // A saved credential is already persistent; it remains authoritative
      // until its validation fails and is never silently replaced by env.
      askPersistence = false;
    } else {
      candidate = await abortableSetupAction(
        () => surface.readSecret({
          backendId: descriptor.id,
          message: `${descriptor.displayName} Zugangsschlüssel`,
        }),
        options.signal!,
      );
      if (candidate === null) return { kind: "cancelled", mode: "setup-required" };
    }

    const outcome = await activateOpenRouter(
      candidate!,
      persistence,
      askPersistence,
      usingSaved ? options.savedCandidatePermit ?? null : null,
      usingSaved,
      options,
    );
    if (outcome.kind === "ready") {
      return completeCrossSetup(surface, registry, stateStore, outcome, options.signal!);
    }
    if (outcome.kind === "cancelled") return { kind: "cancelled", mode: "setup-required" };
    if (usingSaved && outcome.kind === "rejected") {
      savedAvailable = false;
      environmentOffered = nonEmpty(options.environmentSecret) !== null;
    }
  }
}

type ActivationFlow =
  | { kind: "retry" }
  | { kind: "rejected" }
  | { kind: "cancelled" }
  | {
    kind: "ready";
    route: RouteIdentityV1;
    state: ReturnType<ProviderStateStore["read"]> | null;
    models: readonly BackendModelDescriptor[];
  };

async function activateOpenRouter(
  rawSecret: string,
  persistence: "persisted" | "process-only",
  askPersistence: boolean,
  credentialPermit: ProviderCandidateCredentialPermit | null,
  requireCredentialPermit: boolean,
  options: SetupHubOptions,
): Promise<ActivationFlow> {
  const { surface, registry, orchestrator, stateStore } = options;
  const signal = options.signal ?? new AbortController().signal;
  let adapter: BackendAdapter | null = null;
  let candidateId: string | null = null;
  const discardCandidate = async (): Promise<void> => {
    const ownedCandidateId = candidateId;
    if (!ownedCandidateId || !adapter) return;
    candidateId = null;
    try {
      await adapter.discardCandidate(ownedCandidateId);
    } catch {
      // Candidate cleanup is best-effort and never changes the user-visible
      // outcome of an already failed or completed setup attempt.
    }
  };
  const onAbort = () => {
    void discardCandidate();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const secret = normalizeProviderSecret(rawSecret);
    const activeAdapter = registry.adapter("openrouter");
    adapter = activeAdapter;
    const connectAndList = async (
      authorityLease?: ProviderCandidateAuthorityLease,
    ): Promise<
      | { kind: "models"; models: readonly BackendModelDescriptor[] }
      | { kind: "rejected" | "retry" }
    > => {
      const assertCandidateAuthority = async (): Promise<void> => {
        try {
          await authorityLease!.assertCurrent();
        } catch (error) {
          await discardCandidate();
          throw error;
        }
      };
      if (authorityLease) {
        await assertCandidateAuthority();
      }
      const connect = authorityLease && activeAdapter.connectUnderAuthorityLease
        ? (request: Parameters<BackendAdapter["connect"]>[0]) =>
            activeAdapter.connectUnderAuthorityLease!(request, authorityLease)
        : (request: Parameters<BackendAdapter["connect"]>[0]) =>
            activeAdapter.connect(request);
      const candidate = await abortableSetupAction(() => {
        const pending = connect({
          connectionId: options.targetConnectionId,
          candidate: secret,
          generation: options.generation ?? 0,
          signal,
        });
        void pending.then(
          (lateCandidate) => {
            if (signal.aborted && candidateId !== lateCandidate.candidateId) {
              void activeAdapter.discardCandidate(lateCandidate.candidateId)
                .catch(() => undefined);
            }
          },
          () => undefined,
        );
        return pending;
      }, signal);
      candidateId = candidate.candidateId;
      if (authorityLease) {
        await assertCandidateAuthority();
      }
      if (signal.aborted) {
        await discardCandidate();
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("The operation was aborted.", "AbortError");
      }
      if (
        candidate.backendId !== "openrouter"
        || candidate.health.credential !== "valid"
        || candidate.health.connectivity !== "connected"
      ) {
        assertSetupAttemptCurrent(signal);
        surface.present(notice("OpenRouter konnte den Zugangsschlüssel nicht bestätigen."));
        return candidate.health.credential === "rejected"
          ? { kind: "rejected" }
          : { kind: "retry" };
      }
      if (authorityLease) {
        await assertCandidateAuthority();
      }
      const models = compatibleMainModels(await abortableSetupAction(
        () => activeAdapter.listModels({ candidateId: candidate.candidateId, signal }),
        signal,
      ));
      if (authorityLease) {
        await assertCandidateAuthority();
      }
      if (!models.length) {
        assertSetupAttemptCurrent(signal);
        surface.present(notice("OpenRouter stellt keine kompatiblen Main-Modelle bereit."));
        return { kind: "retry" };
      }
      return { kind: "models", models };
    };
    let catalog:
      | { kind: "models"; models: readonly BackendModelDescriptor[] }
      | { kind: "rejected" | "retry" };
    if (options.withCandidateAuthority) {
      const guarded = await abortableSetupAction(
        () => options.withCandidateAuthority!(
          credentialPermit,
          requireCredentialPermit,
          connectAndList,
        ),
        signal,
      );
      if (guarded.kind !== "ready") return { kind: "cancelled" };
      catalog = guarded.value;
    } else {
      if (options.preflightCandidate) {
        let permitted = false;
        try {
          permitted = await abortableSetupAction(
            () => options.preflightCandidate!(),
            signal,
          );
        } catch {
          return { kind: "cancelled" };
        }
        if (!permitted) return { kind: "cancelled" };
      }
      catalog = await abortableSetupAction(() => connectAndList(), signal);
    }
    if (catalog.kind !== "models") return catalog;
    const { models } = catalog;
    const selectedCanonicalModelId = await abortableSetupAction(
      () => surface.chooseModel({ backendId: "openrouter", models }),
      signal,
    );
    if (selectedCanonicalModelId === null) return { kind: "cancelled" };
    const selectedModels = models.filter(
      (model) => model.canonicalModelId === selectedCanonicalModelId,
    );
    if (selectedModels.length !== 1) {
      assertSetupAttemptCurrent(signal);
      surface.present(notice("Die gewählte Modellroute ist nicht verfügbar."));
      return { kind: "retry" };
    }
    const selectedModel = selectedModels[0]!;
    if (askPersistence) {
      const accepted = await abortableSetupAction(
        () => surface.confirm({
          id: "save-openrouter-key",
          message: "OpenRouter-Schlüssel sicher speichern?",
          defaultValue: true,
        }),
        signal,
      );
      if (!accepted) return { kind: "cancelled" };
    }
    const activation = await abortableSetupAction(
      () => orchestrator.activateCandidate({
        expectedRevision: options.expectedRevision ?? stateStore.read().revision,
        candidate: secret,
        expectedRequestedModelId: selectedModel.requestedModelId,
        selectedCanonicalModelId,
        signal,
        persistence,
        targetConnectionId: options.targetConnectionId,
        startupGeneration: options.generation,
      }),
      signal,
    );
    assertSetupAttemptCurrent(signal);
    surface.present(notice("OpenRouter ist eingerichtet."));
    return { kind: "ready", route: activation.route, state: activation.state, models };
  } catch {
    if (signal.aborted) return { kind: "cancelled" };
    // This boundary must never reveal credential bytes or provider error text.
    surface.present(notice("OpenRouter konnte nicht eingerichtet werden. Bitte erneut versuchen."));
    return { kind: "retry" };
  } finally {
    signal.removeEventListener("abort", onAbort);
    await discardCandidate();
  }
}

function createSetupAttempt(
  callerSignal?: AbortSignal,
  deadlineAt?: number,
): { signal: AbortSignal; close(): void } {
  const controller = new AbortController();
  const abortFromCaller = () => {
    if (!controller.signal.aborted) {
      controller.abort(callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new DOMException("The setup attempt was aborted.", "AbortError"));
    }
  };
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (callerSignal?.aborted) abortFromCaller();
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (!controller.signal.aborted && deadlineAt !== undefined && Number.isFinite(deadlineAt)) {
    const remaining = Math.max(0, deadlineAt - Date.now());
    const abortAtDeadline = () => {
      if (!controller.signal.aborted) {
        const timeout = new Error("Provider setup deadline expired.");
        timeout.name = "TimeoutError";
        controller.abort(timeout);
      }
    };
    if (remaining === 0) abortAtDeadline();
    else timer = setTimeout(abortAtDeadline, Math.min(remaining, 0x7fff_ffff));
  }
  return {
    signal: controller.signal,
    close() {
      if (timer !== null) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function assertSetupAttemptCurrent(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The setup attempt was aborted.", "AbortError");
}

function abortableSetupAction<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    assertSetupAttemptCurrent(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => finish(() => {
      try {
        assertSetupAttemptCurrent(signal);
      } catch (error) {
        reject(error);
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => {
        assertSetupAttemptCurrent(signal);
        return operation();
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

function presentSetup(
  surface: SetupSurface,
  presentation: SetupPresentation,
  signal: AbortSignal,
): void {
  assertSetupAttemptCurrent(signal);
  surface.present(presentation);
}

async function completeCrossSetup(
  surface: SetupSurface,
  registry: BackendRegistry,
  stateStore: ProviderStateStore,
  activation: Extract<ActivationFlow, { kind: "ready" }>,
  signal: AbortSignal,
): Promise<SetupHubResult> {
  try {
    presentSetup(
      surface,
      providerState(hubEntries(registry, stateStore, false, activation.route)),
      signal,
    );
    const action = await abortableSetupAction(() => surface.chooseHub([
      { id: "cross-later", label: "Later", description: "Collaboration remains off.", disabled: false, current: true, generation: stateStore.read().revision },
      { id: "cross-prepare", label: "Prepare roles", description: "Store two routes without starting collaboration.", disabled: false, current: false, generation: stateStore.read().revision },
    ]), signal);
    if (action === null || action === "cross-later") return { kind: "ready" };
    if (action !== "cross-prepare") return { kind: "ready" };

    const current = resolvedRoute(activation.route);
    if (!current) {
      presentSetup(surface, notice("Prepare roles benötigt zwei unterschiedliche vollständig aufgelöste Modelle."), signal);
      return { kind: "ready" };
    }
    const choices = activation.models.filter((model) =>
      current.resolutionState === "resolved"
      && current.canonicalModelId !== model.canonicalModelId,
    );
    if (current.resolutionState !== "resolved" || !current.canonicalModelId || !choices.length) {
      presentSetup(surface, notice("Prepare roles benötigt zwei unterschiedliche vollständig aufgelöste Modelle."), signal);
      return { kind: "ready" };
    }
    const chosen = await abortableSetupAction(
      () => surface.chooseModel({ backendId: current.backendId, models: choices }),
      signal,
    );
    const challenger = choices.find((model) => model.canonicalModelId === chosen);
    if (!challenger || challenger.canonicalModelId === current.canonicalModelId) {
      presentSetup(surface, notice("Prepare roles benötigt zwei unterschiedliche vollständig aufgelöste Modelle."), signal);
      return { kind: "ready" };
    }
    const challengerRoute = routeForModel(current, challenger);
    if (!challengerRoute) {
      presentSetup(surface, notice("Prepare roles benötigt zwei unterschiedliche vollständig aufgelöste Modelle."), signal);
      return { kind: "ready" };
    }
    if (activation.state === null) {
      presentSetup(surface, notice("Rollen sind nur für diese Prozessroute vorbereitet. Cross bleibt ausgeschaltet."), signal);
      return { kind: "ready", preparedRoles: { lead: current, challenger: challengerRoute } };
    }
    await abortableSetupAction(
      () => stateStore.commit(
        stateStore.read().revision,
        (state) => ({
          ...state,
          cross: {
            enabled: false,
            preferredLead: current,
            preferredChallenger: challengerRoute,
          },
        }),
        () => assertSetupAttemptCurrent(signal),
      ),
      signal,
    );
    presentSetup(surface, notice("Rollen wurden vorbereitet. Cross bleibt ausgeschaltet."), signal);
    return { kind: "ready" };
  } catch (error) {
    if (signal.aborted) return { kind: "ready" };
    throw error;
  }
}

function compatibleMainModels(models: readonly BackendModelDescriptor[]): BackendModelDescriptor[] {
  return models.filter((model) =>
    model.backendId === "openrouter"
    && model.capabilities.textInput
    && model.capabilities.textOutput
    && model.capabilities.tools
    && Boolean(model.canonicalModelId),
  );
}

function hubEntries(
  registry: BackendRegistry,
  stateStore: ProviderStateStore,
  environmentOffered: boolean,
  currentRoute?: RouteIdentityV1,
): SetupHubEntry[] {
  const state = stateStore.read();
  const entries: SetupHubEntry[] = registry.entries().map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.displayName,
    description: descriptor.maturity === "coming-soon" ? "Coming soon" : "Connect provider",
    disabled: !descriptor.connectable,
    current: (currentRoute ?? state.defaultRoute)?.backendId === descriptor.id,
    generation: state.revision,
  }));
  if (environmentOffered) {
    entries.push({
      id: "openrouter:environment",
      label: "OpenRouter · Umgebung",
      description: "Nur für diesen Prozess verwenden",
      disabled: false,
      current: false,
      generation: state.revision,
    });
  }
  return entries;
}

function descriptorFor(registry: BackendRegistry, id: string): BackendDescriptor | null {
  return registry.entries().find((descriptor) => descriptor.id === id) ?? null;
}

function routeForModel(current: RouteIdentityV1, model: BackendModelDescriptor): RouteIdentityV1 | null {
  return resolvedRoute({
    version: 1,
    backendId: current.backendId,
    accountFingerprint: current.accountFingerprint,
    billingRealm: current.billingRealm,
    requestedModelId: model.requestedModelId,
    canonicalModelId: model.canonicalModelId,
    resolutionState: "resolved",
  });
}

function resolvedRoute(value: unknown): RouteIdentityV1 | null {
  const route = validateRouteIdentityV1(value);
  if (!route || route.resolutionState !== "resolved" || route.canonicalModelId === null) return null;
  return {
    version: 1,
    backendId: route.backendId,
    accountFingerprint: route.accountFingerprint,
    billingRealm: route.billingRealm,
    requestedModelId: route.requestedModelId,
    canonicalModelId: route.canonicalModelId,
    resolutionState: "resolved",
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function notice(message: string): { version: 1; type: "notice"; message: string } {
  return { version: 1, type: "notice", message };
}

function providerState(entries: readonly SetupHubEntry[]): SetupProviderStatePresentation {
  return { version: 1, type: "provider-state", entries: [...entries] };
}

function providerEntryLabel(entry: SetupHubEntry): string {
  if (entry.disabled) return `${entry.label} · Coming soon`;
  return entry.current ? `${entry.label} · Aktuell r${entry.generation}` : entry.label;
}

function providerStateLabel(entries: readonly SetupHubEntry[]): string {
  return entries.map(providerEntryLabel).join(" · ");
}

export interface PlainSetupPromptIo {
  select(request: { message: string; choices: readonly { name: string; value: string }[] }): Promise<string>;
  password(request: { message: string; mask: string }): Promise<string>;
  confirm(request: { message: string; default: boolean }): Promise<boolean>;
}

/** The CLI supplies the existing Inquirer primitives; this module never does. */
export function createPlainSetupSurface(io: PlainSetupPromptIo): SetupSurface {
  let latestStatus = "";
  return {
    async chooseHub(entries) {
      return io.select({
        message: promptMessage("Provider auswählen", latestStatus),
        choices: entries.map((entry) => ({ name: `${providerEntryLabel(entry)} · ${entry.description}`, value: entry.id })),
      }).catch(() => null);
    },
    async readSecret(request) {
      return io.password({ message: request.message, mask: "•" }).catch(() => null);
    },
    async chooseModel(request) {
      return io.select({
        message: "Modell auswählen",
        choices: request.models.map((model) => ({ name: model.displayName, value: model.canonicalModelId })),
      }).catch(() => null);
    },
    async confirm(request) {
      return io.confirm({ message: request.message, default: request.defaultValue }).catch(() => false);
    },
    present(event) {
      if (event.type === "provider-state") latestStatus = providerStateLabel(event.entries);
      else if (event.type === "notice") latestStatus = event.message;
    },
  };
}

function promptMessage(prompt: string, status: string): string {
  return status ? `${status}\n${prompt}` : prompt;
}

export interface TuiSetupPromptUi {
  pickChoice(
    title: string,
    items: readonly { label: string; value: string; description: string }[],
    currentValue: string,
    initialValue?: string,
  ): Promise<{ value: string } | null>;
  readSecret(label: string): Promise<string | null>;
  pickModel(
    search: (query: string) => readonly ModelInfo[],
    currentModel: string,
    title?: string,
  ): Promise<{ id: string } | null>;
  confirmAction(title: string, details: string, rememberAvailable?: boolean): Promise<{ accepted: boolean }>;
  addMessage(role: "user" | "assistant" | "system" | "error", content: string, meta?: string): void;
  setStatus(status: string, busy?: boolean): void;
}

/** The fullscreen UI supplies its existing picker and secret primitives. */
export function createTuiSetupSurface(ui: TuiSetupPromptUi): SetupSurface {
  return {
    async chooseHub(entries) {
      const current = entries.find((entry) => entry.current)?.id ?? "";
      const items = entries.map((entry) => ({
        value: entry.id,
        label: providerEntryLabel(entry),
        description: entry.description,
      }));
      return (await ui.pickChoice("Provider-Setup", items, current, current || (items[0]?.value ?? "")))?.value ?? null;
    },
    readSecret(request) {
      return ui.readSecret(request.message);
    },
    async chooseModel(request) {
      const byId = new Map(request.models.map((model) => [model.canonicalModelId, model]));
      const models = [...byId.values()].map(modelInfo);
      const picked = await ui.pickModel(() => models, "", "Modell auswählen");
      return picked?.id ?? null;
    },
    async confirm(request) {
      return (await ui.confirmAction(request.message, "", false)).accepted;
    },
    present(event) {
      if (event.type === "provider-state") ui.addMessage("system", providerStateLabel(event.entries), "Provider-Setup");
      else if (event.type === "notice") ui.setStatus(event.message, false);
    },
  };
}

function modelInfo(model: BackendModelDescriptor): ModelInfo {
  return {
    id: model.canonicalModelId,
    name: model.displayName,
    description: model.requestedModelId,
    contextLength: 0,
    promptPrice: 0,
    completionPrice: 0,
    supportedParameters: model.capabilities.tools ? ["tools"] : [],
    inputModalities: model.capabilities.textInput ? ["text"] : [],
    outputModalities: model.capabilities.textOutput ? ["text"] : [],
    reasoning: {
      defaultEffort: "low",
      defaultEnabled: false,
      mandatory: false,
      supportedEfforts: ["low"],
      supportsMaxTokens: false,
    },
  };
}
