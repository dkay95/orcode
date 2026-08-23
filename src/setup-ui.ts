import { normalizeProviderSecret } from "./credentials.js";
import type {
  BackendDescriptor,
  BackendId,
  BackendModelDescriptor,
  BackendRegistry,
  RouteIdentityV1,
} from "./backends.js";
import type { ProviderStateStore } from "./provider-state.js";
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
  present(event: SetupEvent | { version: 1; type: "notice"; message: string }): void;
}

export type SetupHubResult =
  | { kind: "cancelled"; mode: "setup-required" }
  | { kind: "ready" };

export interface SetupHubOptions {
  surface: SetupSurface;
  orchestrator: SetupOrchestrator;
  registry: BackendRegistry;
  stateStore: ProviderStateStore;
  /** A saved credential, if one was authoritatively loaded for this startup. */
  savedSecret?: string | null;
  /** Process-only candidate used automatically only when no saved key exists. */
  environmentSecret?: string | null;
}

/**
 * The setup controller deliberately has no terminal dependency. Both prompt
 * transports provide the same small surface, so cancellation and provider
 * boundaries cannot diverge between plain and fullscreen modes.
 */
export async function runSetupHub(options: SetupHubOptions): Promise<SetupHubResult> {
  const { surface, registry, orchestrator, stateStore } = options;
  const savedSecret = nonEmpty(options.savedSecret);
  let pendingEnvironment = savedSecret ? null : nonEmpty(options.environmentSecret);
  let savedAvailable = savedSecret !== null;
  let environmentOffered = false;
  let lastCompatibleModels: readonly BackendModelDescriptor[] = [];

  while (true) {
    if (pendingEnvironment) {
      const secret = pendingEnvironment;
      pendingEnvironment = null;
      const outcome = await activateOpenRouter(
        secret,
        "process-only",
        false,
        options,
        (models) => { lastCompatibleModels = models; },
      );
      if (outcome === "ready") return completeCrossSetup(surface, stateStore, lastCompatibleModels);
      if (outcome === "cancelled") return { kind: "cancelled", mode: "setup-required" };
      continue;
    }

    const entries = hubEntries(registry, stateStore, environmentOffered);
    const selected = await surface.chooseHub(entries);
    if (selected === null) return { kind: "cancelled", mode: "setup-required" };

    if (selected === "openrouter:environment" && environmentOffered) {
      const environment = nonEmpty(options.environmentSecret);
      if (!environment) continue;
      const outcome = await activateOpenRouter(environment, "process-only", false, options, (models) => { lastCompatibleModels = models; });
      if (outcome === "ready") return completeCrossSetup(surface, stateStore, lastCompatibleModels);
      if (outcome === "cancelled") return { kind: "cancelled", mode: "setup-required" };
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
    if (descriptor.id === "openrouter" && savedAvailable) {
      candidate = savedSecret;
      // A saved credential is already persistent; it remains authoritative
      // until its validation fails and is never silently replaced by env.
      askPersistence = false;
      savedAvailable = false;
    } else {
      candidate = await surface.readSecret({
        backendId: descriptor.id,
        message: `${descriptor.displayName} Zugangsschlüssel`,
      });
      if (candidate === null) return { kind: "cancelled", mode: "setup-required" };
    }

    const outcome = await activateOpenRouter(candidate!, persistence, askPersistence, options, (models) => { lastCompatibleModels = models; });
    if (outcome === "ready") return completeCrossSetup(surface, stateStore, lastCompatibleModels);
    if (outcome === "cancelled") return { kind: "cancelled", mode: "setup-required" };
    if (!askPersistence && nonEmpty(options.environmentSecret)) environmentOffered = true;
  }
}

async function activateOpenRouter(
  rawSecret: string,
  persistence: "persisted" | "process-only",
  askPersistence: boolean,
  options: SetupHubOptions,
  onModels: (models: readonly BackendModelDescriptor[]) => void,
): Promise<"retry" | "cancelled" | "ready"> {
  const { surface, registry, orchestrator, stateStore } = options;
  let candidateId: string | null = null;
  try {
    const secret = normalizeProviderSecret(rawSecret);
    const adapter = registry.adapter("openrouter");
    const controller = new AbortController();
    const candidate = await adapter.connect({ candidate: secret, generation: 0, signal: controller.signal });
    candidateId = candidate.candidateId;
    if (
      candidate.backendId !== "openrouter"
      || candidate.health.credential !== "valid"
      || candidate.health.connectivity !== "connected"
    ) {
      surface.present(notice("OpenRouter konnte den Zugangsschlüssel nicht bestätigen."));
      return "retry";
    }
    const models = compatibleMainModels(await adapter.listModels({ candidateId, signal: controller.signal }));
    if (!models.length) {
      surface.present(notice("OpenRouter stellt keine kompatiblen Main-Modelle bereit."));
      return "retry";
    }
    const selectedCanonicalModelId = await surface.chooseModel({ backendId: "openrouter", models });
    if (selectedCanonicalModelId === null) return "cancelled";
    if (!models.some((model) => model.canonicalModelId === selectedCanonicalModelId)) {
      surface.present(notice("Die gewählte Modellroute ist nicht verfügbar."));
      return "retry";
    }
    onModels(models);
    if (askPersistence) {
      const accepted = await surface.confirm({
        id: "save-openrouter-key",
        message: "OpenRouter-Schlüssel sicher speichern?",
        defaultValue: true,
      });
      if (!accepted) return "cancelled";
    }
    await orchestrator.activateCandidate({
      expectedRevision: stateStore.read().revision,
      candidate: secret,
      selectedCanonicalModelId,
      signal: controller.signal,
      persistence,
    });
    surface.present(notice("OpenRouter ist eingerichtet."));
    return "ready";
  } catch {
    // This boundary must never reveal credential bytes or provider error text.
    surface.present(notice("OpenRouter konnte nicht eingerichtet werden. Bitte erneut versuchen."));
    return "retry";
  } finally {
    if (candidateId) {
      try {
        await registry.adapter("openrouter").discardCandidate(candidateId);
      } catch {
        // Candidate cleanup is best-effort and never changes the user-visible
        // outcome of an already failed or completed setup attempt.
      }
    }
  }
}

async function completeCrossSetup(
  surface: SetupSurface,
  stateStore: ProviderStateStore,
  models: readonly BackendModelDescriptor[],
): Promise<SetupHubResult> {
  const action = await surface.chooseHub([
    { id: "cross-later", label: "Later", description: "Collaboration remains off.", disabled: false, current: true, generation: stateStore.read().revision },
    { id: "cross-prepare", label: "Prepare roles", description: "Store two routes without starting collaboration.", disabled: false, current: false, generation: stateStore.read().revision },
  ]);
  if (action === null || action === "cross-later") return { kind: "ready" };
  if (action !== "cross-prepare") return { kind: "ready" };

  const current = stateStore.read().defaultRoute;
  const choices = models.filter((model) =>
    current?.resolutionState === "resolved"
    && current.canonicalModelId !== model.canonicalModelId,
  );
  if (!current || current.resolutionState !== "resolved" || !current.canonicalModelId || !choices.length) {
    surface.present(notice("Prepare roles benötigt zwei unterschiedliche vollständig aufgelöste Modelle."));
    return { kind: "ready" };
  }
  const chosen = await surface.chooseModel({ backendId: current.backendId, models: choices });
  const challenger = choices.find((model) => model.canonicalModelId === chosen);
  if (!challenger || challenger.canonicalModelId === current.canonicalModelId) {
    surface.present(notice("Prepare roles benötigt zwei unterschiedliche vollständig aufgelöste Modelle."));
    return { kind: "ready" };
  }
  await stateStore.commit(stateStore.read().revision, (state) => ({
    ...state,
    cross: {
      enabled: false,
      preferredLead: current,
      preferredChallenger: routeForModel(current, challenger),
    },
  }));
  surface.present(notice("Rollen wurden vorbereitet. Cross bleibt ausgeschaltet."));
  return { kind: "ready" };
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
): SetupHubEntry[] {
  const state = stateStore.read();
  const entries: SetupHubEntry[] = registry.entries().map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.displayName,
    description: descriptor.maturity === "coming-soon" ? "Coming soon" : "Connect provider",
    disabled: !descriptor.connectable,
    current: state.defaultRoute?.backendId === descriptor.id,
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

function routeForModel(current: RouteIdentityV1, model: BackendModelDescriptor): RouteIdentityV1 {
  return {
    ...current,
    requestedModelId: model.requestedModelId,
    canonicalModelId: model.canonicalModelId,
    resolutionState: "resolved",
  };
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function notice(message: string): { version: 1; type: "notice"; message: string } {
  return { version: 1, type: "notice", message };
}

export interface PlainSetupPromptIo {
  select(request: { message: string; choices: readonly { name: string; value: string }[] }): Promise<string>;
  password(request: { message: string; mask: string }): Promise<string>;
  confirm(request: { message: string; default: boolean }): Promise<boolean>;
  present?(event: SetupEvent | { version: 1; type: "notice"; message: string }): void;
}

/** The CLI supplies the existing Inquirer primitives; this module never does. */
export function createPlainSetupSurface(io: PlainSetupPromptIo): SetupSurface {
  return {
    async chooseHub(entries) {
      return io.select({
        message: "Provider auswählen",
        choices: entries.map((entry) => ({ name: `${entry.label} · ${entry.description}`, value: entry.id })),
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
      io.present?.(event);
    },
  };
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
}

/** The fullscreen UI supplies its existing picker and secret primitives. */
export function createTuiSetupSurface(ui: TuiSetupPromptUi): SetupSurface {
  return {
    async chooseHub(entries) {
      const items = entries.map((entry) => ({
        value: entry.id,
        label: entry.disabled ? `${entry.label} · Coming soon` : entry.label,
        description: entry.description,
      }));
      return (await ui.pickChoice("Provider-Setup", items, "", items[0]?.value ?? ""))?.value ?? null;
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
      if (event.type === "notice") ui.addMessage("system", event.message, "Provider-Setup");
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
