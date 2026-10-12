import { normalizeProviderSecret } from "../credentials.js";
import { ANTHROPIC_DIRECT_BACKEND_NOTICE } from "../backends.js";
import type {
  BackendAdapter,
  BackendDescriptor,
  BackendId,
  BackendModelDescriptor,
  BackendRegistry,
  ProviderCandidate,
  RouteIdentityV1,
} from "../backends.js";
import type { ProviderStateStore } from "../provider-state.js";
import type {
  ProviderCandidateAuthorityLease,
  ProviderCandidateAuthorityResult,
  ProviderCandidateCredentialPermit,
  ProviderManualKimiCandidateAuthorityRequest,
} from "../provider-authority.js";
import type {
  ProviderExecutionMode,
  SetupEvent,
  SetupOrchestrator,
} from "../setup.js";
import { KIMI_CODE_MODELS } from "../kimi-code.js";
import {
  isDesktopKimiRuntimeCapability,
  visitKimiExecutionOrigin,
  type DesktopKimiRuntimeCapability,
  type KimiExecutionOrigin,
} from "../kimi-execution-origin.js";
import { createKimiRequestId } from "../native-sidecar-channel.js";
import type { ModelInfo, NoticeKind } from "../types.js";

export interface SetupHubEntry {
  id: string;
  label: string;
  description: string;
  /**
   * A row that redirects instead of connecting. Exactly one exists —
   * Anthropic / Claude, which no surface may offer as an action because
   * `BackendRegistry` forbids it an adapter — and every surface's filter on
   * this flag is what keeps it unpickable by contract rather than by
   * everyone remembering not to build one.
   */
  disabled: boolean;
  current: boolean;
  generation: number;
}

export interface SetupSurface {
  chooseHub(entries: readonly SetupHubEntry[]): Promise<string | null>;
  readSecret(request: { backendId: BackendId; message: string }): Promise<string | null>;
  chooseModel(request: { backendId: BackendId; models: readonly BackendModelDescriptor[] }): Promise<string | null>;
  /**
   * D4: `danger` (default false — every existing call site is a benign
   * setup choice) threads the controller's confirm-class grading through
   * to whichever adapter is active; each adapter still owns its own
   * underlying primitive (delegation, not a new implementation here).
   * `consequence` (fix round 1, MINOR 3: latent hardening — no danger
   * setup site exists yet) mirrors `confirmPlain`'s danger path on the
   * plain adapter: states what accepting does before the prompt itself,
   * printed separately so it survives once the prompt collapses.
   */
  confirm(request: {
    id: string;
    message: string;
    defaultValue: boolean;
    danger?: boolean;
    consequence?: string;
  }): Promise<boolean>;
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
  /**
   * `busy` (Phase 7, E-VIS-02): true only for the transient "still working"
   * notice shown while `activateProvider` validates a credential or lists
   * models — both real network calls that previously had no presentation
   * at all. Every other notice keeps the default `false` (a settled
   * outcome), unchanged from before this field existed.
   *
   * `outcome` (FIX-18): true for a SETTLED outcome of a setup attempt — a
   * success, a named failure with its reason, or an explicit cancel. Outcome
   * notices must render durably on every surface (the fullscreen surface's
   * status line is clobbered by the next prompt's own mode switch, which is
   * exactly how "OpenRouter could not validate the API key." used to vanish
   * without a trace). A non-outcome notice is a pre-prompt disclosure or a
   * busy line and keeps the F7 pending-secret-notice channel.
   */
  | {
    version: 1;
    type: "notice";
    message: string;
    busy?: boolean;
    outcome?: boolean;
    /**
     * FIX-18: optional short headline for a LONG outcome message. The chat
     * transcript's notice card truncates its title line instead of wrapping
     * it (render-block.ts) — a title keeps the headline short and puts the
     * full message on the wrapped cause lines, so nothing is cut off.
     */
    title?: string;
  }
  | SetupProviderStatePresentation;

/**
 * FIX-18: why a setup attempt was refused by the candidate-authority or
 * preflight layer. Every one of these used to exit `runSetupHub` with NO
 * presentation at all — the product's first-run gate failing silently.
 */
type SetupBlockedReason =
  | "stale"
  | "forget-pending"
  | "recovery-required"
  | "unavailable";

export type SetupHubResult =
  | { kind: "cancelled"; mode: "setup-required" }
  | { kind: "ready"; preparedRoles?: SetupPreparedRoles };

// Not exported (F6 dead-layer sweep): only this file's own manual-provider
// contact flow builds one, as a local variable.
interface SetupExecutionContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly generation: number;
  readonly expectedRevision: number;
  readonly targetConnectionId?: string;
  readonly candidatePermit: ProviderCandidateCredentialPermit | null;
  readonly requireCandidatePermit: boolean;
  readonly executionMode: ProviderExecutionMode;
}

export interface SetupHubOptions {
  surface: SetupSurface;
  orchestrator: SetupOrchestrator;
  registry: BackendRegistry;
  stateStore: ProviderStateStore;
  executionMode?: ProviderExecutionMode;
  initialBackendId?: "openrouter" | "kimi-code";
  /** A saved credential, if one was authoritatively loaded for this startup. */
  savedSecret?: string | null;
  /**
   * FIX-18 (F4): true when a configured connection EXISTS but its saved key
   * could not be read. The picker then states the honest row state ("Key
   * missing — enter it again") instead of presenting the connection as
   * intact, and the launch notice names the cause exactly once.
   */
  savedCredentialUnavailable?: boolean;
  /** Process-only candidate used automatically only when no saved key exists. */
  environmentSecret?: string | null;
  /** Existing whole-startup attempt. Omitted for an independent manual setup. */
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Lazily starts the provider-contact budget after interactive secret input. */
  resolveProviderDeadline?: () => number;
  generation?: number;
  targetConnectionId?: string;
  /** Durable revision captured with an authority-backed saved credential. */
  expectedRevision?: number;
  savedCandidatePermit?: ProviderCandidateCredentialPermit | null;
  environmentCandidatePermit?: ProviderCandidateCredentialPermit | null;
  /** Reasserts that no provider cleanup/recovery journal blocks candidate IO. */
  preflightCandidate?: () => Promise<boolean>;
  /** Proves candidate authority across catalog selection and activation. */
  withCandidateAuthority?: <T>(
    credentialPermit: ProviderCandidateCredentialPermit | null,
    requireCredentialPermit: boolean,
    use: (lease: ProviderCandidateAuthorityLease) => Promise<T>,
  ) => Promise<ProviderCandidateAuthorityResult<T>>;
  /** Observes one first Kimi paste and returns only metadata plus an opaque permit. */
  withManualKimiCandidateAuthority?: <T>(
    request: ProviderManualKimiCandidateAuthorityRequest,
    inspect: (
      normalizedCandidate: string,
      lease: ProviderCandidateAuthorityLease,
    ) => Promise<{ candidate: ProviderCandidate; value: T }>,
  ) => Promise<ProviderCandidateAuthorityResult<{
    value: T;
    candidatePermit: ProviderCandidateCredentialPermit;
  }>>;
  releaseManualKimiCandidatePermit?: (
    permit: ProviderCandidateCredentialPermit,
  ) => void;
  /** Task 4 supplies this closed origin and secretless native correlation at the live GUI call site. */
  kimiExecutionOrigin?: KimiExecutionOrigin;
  /** Task 5-minted private desktop authority; never derived by this setup controller. */
  desktopKimiCapability?: DesktopKimiRuntimeCapability;
  kimiDesktopSetupContext?: Readonly<{
    sessionId: string;
    childPid: number;
    setupId: string;
  }>;
  /** Exact runtime setup attempt; false fences every late presentation effect. */
  isCurrent?: () => boolean;
}

const SETUP_CALLER_ABORTED = Symbol("setup-caller-aborted");
const MANUAL_PROVIDER_CONTACT_MAX_MS = 15_000;

function isClosedKimiDesktopSetupContext(
  value: SetupHubOptions["kimiDesktopSetupContext"],
): value is NonNullable<SetupHubOptions["kimiDesktopSetupContext"]> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !["childPid", "sessionId", "setupId"].every((key) => keys.includes(key))) return false;
  if (!keys.every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  })) return false;
  return typeof value.sessionId === "string" && value.sessionId.length > 0
    && Number.isSafeInteger(value.childPid) && value.childPid > 0
    && typeof value.setupId === "string" && value.setupId.length > 0;
}

function awaitSetupInput<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof SETUP_CALLER_ABORTED> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.resolve(SETUP_CALLER_ABORTED);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: T | typeof SETUP_CALLER_ABORTED) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(SETUP_CALLER_ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(finish, (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
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
  } finally {
    attempt.close();
  }
}

async function runSetupHubAttempt(options: SetupHubOptions): Promise<SetupHubResult> {
  const { surface, registry, orchestrator, stateStore } = options;
  const cancellationRevision = options.expectedRevision ?? stateStore.read().revision;
  let cancellation: Promise<SetupHubResult> | null = null;
  const cancelOnce = (
    phase: "hub" | "secret" | "model" | "persistence",
    reason: unknown = { code: "provider-setup-cancelled", phase },
    presentOutcome = true,
  ): Promise<SetupHubResult> => {
    if (!cancellation) {
      cancellation = orchestrator.cancelSetup({
        reason,
        expectedRevision: cancellationRevision,
        ...(options.generation === undefined
          ? {}
          : { expectedGeneration: options.generation }),
      }).then(() => {
        if (presentOutcome && !options.signal?.aborted && options.isCurrent?.() !== false) {
          surface.present(outcomeNotice("Setup cancelled. No account was connected."));
        }
        return { kind: "cancelled" as const, mode: "setup-required" as const };
      });
    }
    return cancellation;
  };
  /**
   * FIX-18 structural guarantee: a blocked activation ends the whole setup
   * flow, so it must state one honest outcome line before it does — the
   * previous `return { kind: "cancelled", … }` here was completely silent
   * (no notice, no cancel event, no log), which is how a valid key could
   * die between credential validation and the model chooser with nothing
   * on screen. Fenced exactly like `cancelOnce`'s notice: an aborted or
   * superseded attempt never presents late.
   */
  const blockedExit = (reason: SetupBlockedReason): SetupHubResult => {
    if (!options.signal?.aborted && options.isCurrent?.() !== false) {
      surface.present(outcomeNotice(blockedOutcomeMessage(reason), "Setup stopped"));
    }
    return { kind: "cancelled", mode: "setup-required" };
  };
  const savedSecret = nonEmpty(options.savedSecret);
  let pendingEnvironment = savedSecret ? null : nonEmpty(options.environmentSecret);
  let savedAvailable = savedSecret !== null;
  let environmentOffered = false;
  // FIX-18 (F4): the keyless-configured cause is stated exactly once, at the
  // first picker round — never repeated on retries.
  let savedCredentialCauseStated = options.savedCredentialUnavailable !== true;
  let initialBackendId = options.initialBackendId;

  while (true) {
    if (options.signal?.aborted) return cancelOnce("hub", options.signal.reason);
    if (pendingEnvironment) {
      const secret = pendingEnvironment;
      pendingEnvironment = null;
      const outcome = await activateProvider(
        "openrouter",
        secret,
        "process-only",
        false,
        options.environmentCandidatePermit ?? null,
        true,
        options,
      );
      if (outcome.kind === "ready") {
        return { kind: "ready" };
      }
      if (outcome.kind === "cancelled") {
        return cancelOnce(outcome.phase, outcome.reason);
      }
      if (outcome.kind === "blocked") return blockedExit(outcome.reason);
      continue;
    }

    if (!savedCredentialCauseStated) {
      savedCredentialCauseStated = true;
      surface.present(outcomeNotice(
        "The saved OpenRouter API key could not be read, so it must be entered again.",
        "Saved key unreadable",
      ));
    }
    const entries = hubEntries(
      registry,
      stateStore,
      environmentOffered,
      options.savedCredentialUnavailable === true,
    );
    surface.present(providerState(entries));
    const selected = initialBackendId
      ?? await awaitSetupInput(surface.chooseHub(entries), options.signal);
    initialBackendId = undefined;
    if (selected === SETUP_CALLER_ABORTED) {
      return cancelOnce("hub", options.signal?.reason);
    }
    if (options.signal?.aborted) return cancelOnce("hub", options.signal.reason);
    if (selected === null) {
      return cancelOnce("hub");
    }

    if (selected === "openrouter:environment" && environmentOffered) {
      const environment = nonEmpty(options.environmentSecret);
      if (!environment) continue;
      const outcome = await activateProvider(
        "openrouter",
        environment,
        "process-only",
        false,
        options.environmentCandidatePermit ?? null,
        true,
        options,
      );
      if (outcome.kind === "ready") {
        return { kind: "ready" };
      }
      if (outcome.kind === "cancelled") {
        return cancelOnce(outcome.phase, outcome.reason);
      }
      if (outcome.kind === "blocked") return blockedExit(outcome.reason);
      continue;
    }

    // FIX-12: one fail-closed guard for every selection this flow cannot
    // run, replacing the two branches that answered "Coming soon is not
    // selectable" — a claim that was never true of either backend. Neither
    // is reachable through a picker (`codex` has no descriptor at all;
    // `anthropic`'s row is `disabled`, which every surface filters), so
    // arriving here means a surface returned something it was not offered.
    // The guard is still not redundant: without it that value would fall
    // straight through to the OpenRouter branch below and prompt for —
    // then activate — a credential under another provider's name.
    // FIX-18 at merge: the refusal is a settled outcome, so it rides the
    // outcome-notice channel like every other setup exit.
    const descriptor = descriptorFor(registry, selected);
    if (!descriptor?.connectable || !isRunnableSetupBackend(descriptor.id)) {
      surface.present(outcomeNotice(descriptor?.id === "anthropic"
        ? ANTHROPIC_DIRECT_BACKEND_NOTICE
        : "This provider selection is unavailable and was not used."));
      return { kind: "cancelled", mode: "setup-required" };
    }

    if (descriptor.id === "kimi-code") {
      if (options.executionMode !== "local-interactive-owner"
        && options.kimiExecutionOrigin?.kind !== "desktop-native") {
        // FIX-9 wording (plain words, no execution-mode jargon) on FIX-18's
        // settled-outcome channel.
        surface.present(outcomeNotice("Kimi Code can only be set up here in the terminal, on your own machine.", "Kimi Code unavailable here"));
        return { kind: "cancelled", mode: "setup-required" };
      }
      const selectedState = stateStore.read();
      const selectedRevision = selectedState.revision;
      const existingConnections = selectedState.connections.filter((connection) =>
        connection.backendId === "kimi-code",
      );
      if (existingConnections.length > 1) {
        // FIX-10 M2 (honesty): "Repair provider setup" named no action that
        // exists. The one catalog-verified operation that actually reduces
        // the connection count is `/provider logout kimi-code` — its forget
        // path removes the selected connection entirely (`/provider
        // disconnect` is deliberately unapproved for kimi-code and fails at
        // the parser, and `disable` only flips `enabled`, which this count
        // ignores). Same remedy family as the OpenRouter sibling notice
        // ("Remove them individually with /provider logout", commands.ts).
        // FIX-18 at merge: a settled outcome, so it rides the outcome channel.
        surface.present(outcomeNotice(
          "Multiple Kimi Code connections exist, so the connection to replace is ambiguous. Remove them individually with /provider logout kimi-code, then retry.",
          "Kimi Code connections ambiguous",
        ));
        return { kind: "cancelled", mode: "setup-required" };
      }
      // F7 (ruling 3, replace-confirm fold): the separate "Replace the
      // existing key?" confirm no longer exists as its own layer — the
      // decision relocates into the secret prompt's own copy, which states
      // the consequence BEFORE input (an existing key's presence with its
      // masked account tail, that submitting replaces it, and that Esc
      // cancels). Submitting the secret IS the confirmation; Esc still
      // aborts with the exact pre-F7 cancel-never-success outcome below.
      const existingConnection = existingConnections[0] ?? null;
      if (options.kimiExecutionOrigin?.kind === "desktop-native") {
        const capability = options.desktopKimiCapability;
        const native = options.kimiDesktopSetupContext;
        if (!isDesktopKimiRuntimeCapability(capability)
          || !isClosedKimiDesktopSetupContext(native)
          || native.childPid !== capability.childPid) {
          return cancelOnce("secret", undefined, false);
        }
        const nativeNow = capability.now();
        const nativeDeadlineAt = nativeNow + 60_000;
        if (!Number.isSafeInteger(nativeNow)
          || !Number.isSafeInteger(nativeDeadlineAt)
          || nativeDeadlineAt <= nativeNow) return cancelOnce("secret", undefined, false);
        try {
          await capability.permitReader.issueSetup({
            requestId: createKimiRequestId(),
            sessionId: native.sessionId,
            childPid: capability.childPid,
            setupId: native.setupId,
            provider: "kimi-code",
            operation: existingConnection === null ? "initial-setup" : "replace",
            revision: selectedRevision,
            generation: capability.generation,
            deadlineAt: nativeDeadlineAt,
          }, {
            signal: options.signal,
            onActionWritten: capability.emitRequirement,
          });
        } catch (error) {
          return cancelOnce("secret", error, false);
        }
      } else if (options.desktopKimiCapability !== undefined) {
        return cancelOnce("secret", undefined, false);
      }
      const replaceConsequence = existingConnection
        ? `An existing Kimi Code membership key is connected (account ${maskedAccountTail(existingConnection.accountFingerprint)}). Submitting a new key replaces it; press Esc to keep the current one and go back. `
        : "";
      // The cost-disclosure sentence itself is unchanged verbatim from
      // before the fold (Phase 5's critical promptMessage-fold fix) — only
      // the optional replace-consequence prefix is new, and only appears
      // when there is an existing connection to replace.
      surface.present(notice(
        `${replaceConsequence}The membership key uses a third-party integration with provider-managed limits; paid Extra Usage may apply, and the USD amount is not known here.`,
      ));
      const secretInput = await awaitSetupInput(surface.readSecret({
        backendId: "kimi-code",
        message: "Kimi Code membership key",
      }), options.signal);
      if (secretInput === SETUP_CALLER_ABORTED || options.signal?.aborted) {
        return cancelOnce("secret", options.signal?.reason);
      }
      if (secretInput === null) {
        // Preserves the pre-F7 no-effect guarantee for a declined replace:
        // no `cancelSetup` call, so the existing connection's lifecycle and
        // Cross preferences stay completely untouched — the honest
        // no-effect line still states it. FIX-18 (Esc depth): Escape at the
        // key stage now steps back to the provider list instead of ending
        // the whole setup; the full cancel (with its explicit notice)
        // belongs to the list level alone. Deliberately NOT phrased as
        // "Setup cancelled" — setup is still running at the list.
        if (existingConnection) {
          surface.present(outcomeNotice("The existing Kimi Code account was not changed."));
        }
        continue;
      }
      const targetConnectionId = existingConnections.length === 1
        ? existingConnections[0]!.id
        : options.targetConnectionId;
      const outcome = await activateProvider(
        "kimi-code",
        secretInput,
        "persisted",
        false,
        null,
        true,
        {
          ...options,
          targetConnectionId,
          expectedRevision: options.expectedRevision ?? selectedRevision,
        },
      );
      if (outcome.kind === "ready") {
        return { kind: "ready" };
      }
      if (outcome.kind === "cancelled") {
        return cancelOnce(outcome.phase, outcome.reason);
      }
      if (outcome.kind === "blocked") return blockedExit(outcome.reason);
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
      surface.present(notice(
        "OpenRouter uses an API key and pay as you go billing through OpenRouter.",
      ));
      const secretInput = await awaitSetupInput(
        surface.readSecret({
          backendId: descriptor.id,
          message: `${descriptor.displayName} API key`,
        }),
        options.signal,
      );
      if (secretInput === SETUP_CALLER_ABORTED) {
        return cancelOnce("secret", options.signal?.reason);
      }
      candidate = secretInput;
      if (options.signal?.aborted) return cancelOnce("secret", options.signal.reason);
      // FIX-18 (Esc depth): Esc at the key stage steps back ONE level to
      // the provider list; only Esc at the list level cancels the whole
      // setup, and that cancel keeps its explicit notice. The secret
      // prompt's own hint says "Esc back" to match.
      if (candidate === null) continue;
    }

    const outcome = await activateProvider(
      "openrouter",
      candidate!,
      persistence,
      askPersistence,
      usingSaved ? options.savedCandidatePermit ?? null : null,
      usingSaved,
      options,
    );
    if (outcome.kind === "ready") {
      return { kind: "ready" };
    }
    if (outcome.kind === "cancelled") {
      return cancelOnce(outcome.phase, outcome.reason);
    }
    if (outcome.kind === "blocked") return blockedExit(outcome.reason);
    if (usingSaved && outcome.kind === "rejected") {
      savedAvailable = false;
      environmentOffered = nonEmpty(options.environmentSecret) !== null;
    }
  }
}

type ActivationFlow =
  | { kind: "retry" }
  | { kind: "rejected" }
  | { kind: "blocked"; reason: SetupBlockedReason }
  | {
    kind: "cancelled";
    phase: "model" | "persistence" | "hub" | "secret";
    reason?: unknown;
  }
  | {
    kind: "ready";
    route: RouteIdentityV1;
    state: ReturnType<ProviderStateStore["read"]> | null;
    models: readonly BackendModelDescriptor[];
  };

async function activateProvider(
  backendId: "openrouter" | "kimi-code",
  rawSecret: string,
  persistence: "persisted" | "process-only",
  askPersistence: boolean,
  credentialPermit: ProviderCandidateCredentialPermit | null,
  requireCredentialPermit: boolean,
  options: SetupHubOptions,
): Promise<ActivationFlow> {
  // Phase 7 (E-VIS-02): connect() and listModels() below are both real
  // network calls with no prior presentation — until this, the terminal
  // just sat still, indistinguishable from a hang, for however long
  // credential validation and catalog listing took. One notice, shared by
  // both backends, closes that gap; the existing success/retry/rejected
  // notices below still fire exactly as before once the real outcome lands.
  options.surface.present(notice("Checking credentials …", "busy"));
  if (backendId === "kimi-code") {
    return activateKimiProvider(rawSecret, options);
  }
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
    // Human input is deliberately outside this provider-contact budget. Once
    // contact begins, connect, catalog selection, and activation share one
    // absolute deadline; an external startup deadline is never extended.
    const candidateDeadlineAt = options.deadlineAt
      ?? options.resolveProviderDeadline?.()
      ?? Date.now() + MANUAL_PROVIDER_CONTACT_MAX_MS;
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
          deadlineAt: candidateDeadlineAt,
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
        surface.present(outcomeNotice("OpenRouter could not validate the API key."));
        return candidate.health.credential === "rejected"
          ? { kind: "rejected" }
          : { kind: "retry" };
      }
      // FIX-18 (F1 root cause): a candidate can pass the credential and
      // connectivity checks above yet still not be route eligible — the
      // adapter refuses to store it when the spend limit is reached or the
      // key's account identity is missing (`#inspectSecret`'s
      // `routeEligible`). `listModels` then throws a generic error that the
      // authority layer flattened into a silent "blocked" exit: the flow
      // died between credential validation and the model chooser with no
      // models request, nothing saved, and nothing on screen. Name each
      // reason here and stay in the flow instead.
      if (candidate.health.spend === "limit-reached") {
        assertSetupAttemptCurrent(signal);
        surface.present(outcomeNotice(
          "OpenRouter validated the API key, but the account's spend limit is already reached.",
          "Spend limit reached",
        ));
        return { kind: "retry" };
      }
      if (!candidate.accountFingerprint) {
        assertSetupAttemptCurrent(signal);
        surface.present(outcomeNotice(
          "OpenRouter validated the API key but did not identify the account, so setup cannot finish. Try again or use a different key.",
          "Account identity missing",
        ));
        return { kind: "retry" };
      }
      if (authorityLease) {
        await assertCandidateAuthority();
      }
      const models = compatibleMainModels(
        "openrouter",
        await abortableSetupAction(
          () => activeAdapter.listModels({ candidateId: candidate.candidateId, signal }),
          signal,
        ),
      );
      if (authorityLease) {
        await assertCandidateAuthority();
      }
      if (!models.length) {
        assertSetupAttemptCurrent(signal);
        surface.present(outcomeNotice("OpenRouter did not return a compatible main model."));
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
      if (guarded.kind !== "ready") {
        if (signal.aborted) {
          return { kind: "cancelled", phase: "model", reason: signal.reason };
        }
        return { kind: "blocked", reason: guarded.kind };
      }
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
          if (signal.aborted) {
            return { kind: "cancelled", phase: "model", reason: signal.reason };
          }
          return { kind: "blocked", reason: "recovery-required" };
        }
        if (!permitted) return { kind: "blocked", reason: "recovery-required" };
      }
      catalog = await abortableSetupAction(() => connectAndList(), signal);
    }
    if (catalog.kind !== "models") return catalog;
    const { models } = catalog;
    const selectedCanonicalModelId = await awaitSetupInput(
      surface.chooseModel({ backendId: "openrouter", models }),
      signal,
    );
    if (selectedCanonicalModelId === SETUP_CALLER_ABORTED) {
      return { kind: "cancelled", phase: "model", reason: signal.reason };
    }
    if (signal.aborted) {
      return { kind: "cancelled", phase: "model", reason: signal.reason };
    }
    if (selectedCanonicalModelId === null) return { kind: "cancelled", phase: "model" };
    const selectedModels = models.filter(
      (model) => model.canonicalModelId === selectedCanonicalModelId,
    );
    if (selectedModels.length !== 1) {
      assertSetupAttemptCurrent(signal);
      surface.present(outcomeNotice("The selected model route is unavailable."));
      return { kind: "retry" };
    }
    const selectedModel = selectedModels[0]!;
    if (askPersistence) {
      const accepted = await awaitSetupInput(
        surface.confirm({
          id: "save-openrouter-key",
          message: "Save the OpenRouter API key securely? No cancels setup without activating the account.",
          defaultValue: true,
        }),
        signal,
      );
      if (accepted === SETUP_CALLER_ABORTED) {
        return { kind: "cancelled", phase: "persistence", reason: signal.reason };
      }
      if (signal.aborted) {
        return { kind: "cancelled", phase: "persistence", reason: signal.reason };
      }
      if (!accepted) return { kind: "cancelled", phase: "persistence" };
    }
    const activationPromise = orchestrator.activateCandidate({
      backendId: "openrouter",
      expectedRevision: options.expectedRevision ?? stateStore.read().revision,
      candidate: secret,
      expectedRequestedModelId: selectedModel.requestedModelId,
      selectedCanonicalModelId,
      signal,
      deadlineAt: candidateDeadlineAt,
      persistence,
      candidatePermit: credentialPermit,
      requireCandidatePermit: requireCredentialPermit,
      targetConnectionId: options.targetConnectionId,
      startupGeneration: options.generation,
    });
    const activation = await activationPromise;
    if (!signal.aborted && options.isCurrent?.() !== false) {
      surface.present(outcomeNotice("OpenRouter account is ready."));
    }
    return { kind: "ready", route: activation.route, state: activation.state, models };
  } catch {
    if (signal.aborted) {
      return { kind: "cancelled", phase: "model", reason: signal.reason };
    }
    // This boundary must never reveal credential bytes or provider error text.
    surface.present(outcomeNotice("OpenRouter setup failed. Try again."));
    return { kind: "retry" };
  } finally {
    signal.removeEventListener("abort", onAbort);
    await discardCandidate();
  }
}

async function activateKimiProvider(
  rawSecret: string,
  options: SetupHubOptions,
): Promise<ActivationFlow> {
  const { surface, registry, orchestrator, stateStore } = options;
  const signal = options.signal ?? new AbortController().signal;
  const authority = options.withManualKimiCandidateAuthority;
  const executionMode = options.executionMode ?? "unenrolled-device";
  const executionOrigin = options.kimiExecutionOrigin;
  if (!authority || !options.releaseManualKimiCandidatePermit) {
    return { kind: "blocked", reason: "unavailable" };
  }
  if (executionOrigin === undefined && executionMode !== "local-interactive-owner") {
    return { kind: "blocked", reason: "unavailable" };
  }
  if (executionOrigin?.kind === "terminal-local" && executionMode !== "local-interactive-owner") {
    return { kind: "blocked", reason: "unavailable" };
  }
  if (executionOrigin?.kind === "desktop-native"
    && (!isClosedKimiDesktopSetupContext(options.kimiDesktopSetupContext)
      || !isDesktopKimiRuntimeCapability(options.desktopKimiCapability))) {
    return { kind: "blocked", reason: "unavailable" };
  }
  if (executionOrigin?.kind !== "desktop-native"
    && (options.kimiDesktopSetupContext !== undefined
      || options.desktopKimiCapability !== undefined)) {
    return { kind: "blocked", reason: "unavailable" };
  }

  let adapter: BackendAdapter | null = null;
  let candidateId: string | null = null;
  let candidatePermit: ProviderCandidateCredentialPermit | null = null;
  const discardCandidate = async (): Promise<void> => {
    const ownedCandidateId = candidateId;
    if (!ownedCandidateId || !adapter) return;
    candidateId = null;
    try {
      await adapter.discardCandidate(ownedCandidateId);
    } catch {
      // Candidate cleanup is best effort; the permit is revoked separately.
    }
  };
  const onAbort = () => { void discardCandidate(); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    assertSetupAttemptCurrent(signal);
    const deadlineAt = options.deadlineAt
      ?? options.resolveProviderDeadline?.()
      ?? Date.now() + MANUAL_PROVIDER_CONTACT_MAX_MS;
    const generation = options.generation ?? orchestrator.nextStartupGeneration();
    const context: SetupExecutionContext = Object.freeze({
      signal,
      deadlineAt,
      generation,
      expectedRevision: options.expectedRevision ?? stateStore.read().revision,
      ...(options.targetConnectionId === undefined
        ? {}
        : { targetConnectionId: options.targetConnectionId }),
      candidatePermit: null,
      requireCandidatePermit: true,
      executionMode,
    });
    const activeAdapter = registry.adapter("kimi-code");
    if (activeAdapter.backendId !== "kimi-code") return { kind: "blocked", reason: "unavailable" };
    adapter = activeAdapter;

    if (executionOrigin?.kind === "terminal-local") {
      await visitKimiExecutionOrigin(executionOrigin, {
        terminal: async (ownerAuthority) => ownerAuthority.assertCurrent(),
        desktop: async () => { throw new TypeError("A terminal Kimi origin is required."); },
      });
    }

    const guarded = await abortableSetupAction(
      () => authority({
        backendId: "kimi-code",
        candidate: rawSecret,
        expectedRevision: context.expectedRevision,
        generation: context.generation,
        ...(context.targetConnectionId === undefined
          ? {}
          : { targetConnectionId: context.targetConnectionId }),
        purpose: "initial-setup",
        deadlineAt: context.deadlineAt,
        signal: context.signal,
      }, async (normalizedCandidate, lease) => {
        await lease.assertCurrent();
        const connect = activeAdapter.connectUnderAuthorityLease
          ? (request: Parameters<BackendAdapter["connect"]>[0]) =>
              activeAdapter.connectUnderAuthorityLease!(request, lease)
          : (request: Parameters<BackendAdapter["connect"]>[0]) =>
              activeAdapter.connect(request);
        const candidate = await abortableSetupAction(() => connect({
          connectionId: context.targetConnectionId,
          candidate: normalizedCandidate,
          generation: context.generation,
          deadlineAt: context.deadlineAt,
          signal: context.signal,
        }), context.signal);
        candidateId = candidate.candidateId;
        await lease.assertCurrent();
        const models = compatibleMainModels(
          "kimi-code",
          await abortableSetupAction(
            () => activeAdapter.listModels({
              candidateId: candidate.candidateId,
              connectionId: candidate.connectionId,
              signal: context.signal,
            }),
            context.signal,
          ),
        );
        await lease.assertCurrent();
        return {
          candidate,
          value: {
            models,
            connectionId: candidate.connectionId,
          },
        };
      }),
      signal,
    );
    if (guarded.kind !== "ready") {
      if (signal.aborted) {
        return { kind: "cancelled", phase: "model", reason: signal.reason };
      }
      return { kind: "blocked", reason: guarded.kind };
    }
    candidatePermit = guarded.value.candidatePermit;
    const { models, connectionId } = guarded.value.value;
    if (models.length === 0) {
      assertSetupAttemptCurrent(signal);
      surface.present(outcomeNotice("Kimi Code did not return a compatible coding model."));
      return { kind: "retry" };
    }
    const selectedCanonicalModelId = await awaitSetupInput(
      surface.chooseModel({ backendId: "kimi-code", models }),
      signal,
    );
    if (selectedCanonicalModelId === SETUP_CALLER_ABORTED || signal.aborted) {
      return { kind: "cancelled", phase: "model", reason: signal.reason };
    }
    if (selectedCanonicalModelId === null) {
      return { kind: "cancelled", phase: "model" };
    }
    const selectedModels = models.filter((model) =>
      model.requestedModelId === selectedCanonicalModelId
      && model.canonicalModelId === selectedCanonicalModelId,
    );
    if (selectedModels.length !== 1) {
      surface.present(outcomeNotice("The selected model route is unavailable."));
      return { kind: "retry" };
    }
    const selectedModel = selectedModels[0]!;
    const activation = await orchestrator.activateCandidate({
      backendId: "kimi-code",
      expectedRevision: context.expectedRevision,
      candidate: rawSecret,
      expectedRequestedModelId: selectedModel.requestedModelId,
      selectedCanonicalModelId: selectedModel.canonicalModelId,
      signal: context.signal,
      deadlineAt: context.deadlineAt,
      persistence: "persisted",
      environmentEligibility: "forbidden",
      candidatePermit,
      requireCandidatePermit: true,
      candidateAuthorityPurpose: "initial-setup",
      targetConnectionId: connectionId,
      startupGeneration: context.generation,
    });
    if (!signal.aborted && options.isCurrent?.() !== false) {
      surface.present(outcomeNotice("Kimi Code membership account is ready."));
    }
    return {
      kind: "ready",
      route: activation.route,
      state: activation.state,
      models,
    };
  } catch {
    if (signal.aborted) {
      return { kind: "cancelled", phase: "model", reason: signal.reason };
    }
    surface.present(outcomeNotice("Kimi Code setup failed. Try again."));
    return { kind: "retry" };
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (candidatePermit) {
      options.releaseManualKimiCandidatePermit(candidatePermit);
      candidatePermit = null;
    }
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

const KIMI_SETUP_MODEL_IDS: ReadonlySet<string> = new Set(
  KIMI_CODE_MODELS.map((model) => model.id),
);

/**
 * OpenRouter's automatic router — the shipped default main model
 * (`DEFAULT_CONFIG.mainModel`, config.ts) and the row `/model` ranks first
 * when nothing is typed (`modelSearchScore`, commands.ts).
 */
export const AUTOMATIC_OPENROUTER_MODEL_ID = "openrouter/auto";

function isAutomaticOpenRouterRoute(model: BackendModelDescriptor): boolean {
  return model.backendId === "openrouter"
    && model.requestedModelId === AUTOMATIC_OPENROUTER_MODEL_ID;
}

/**
 * The main-role contract at the descriptor layer. This is the same rule
 * `isMainModelCandidate` (openrouter.ts) applies to catalog models,
 * including its one approved exception — and it exists so setup and
 * `/model` can no longer disagree about what is choosable.
 *
 * They did disagree: OpenRouter publishes `openrouter/auto` with empty
 * modalities and no `supported_parameters`, so the literal
 * textInput/textOutput/tools check this used to be dropped the very model
 * a fresh install ships with. The shipped default was therefore absent
 * from the setup picker, and the zero-touch environment fast path
 * (`createAutomaticEnvironmentSetupSurface`, cli.ts), which asks for an
 * exact match on that same default, could never find one either.
 */
export function isSetupMainModelCandidate(model: BackendModelDescriptor): boolean {
  if (!model.canonicalModelId) return false;
  if (isAutomaticOpenRouterRoute(model)) return true;
  return model.capabilities.textInput
    && model.capabilities.textOutput
    && model.capabilities.tools;
}

/**
 * Row copy for the automatic route. OpenRouter's own catalog name for it is
 * just "Auto", which says nothing about what picking it does or costs; the
 * upstream model is chosen per request, so there is no price to quote up
 * front and none is implied here (this codebase never renders a fabricated
 * one — see `priceSummary`/`formatPricePerMillion`, commands.ts). Applied
 * where rows are rendered, never to the descriptor itself: identity
 * comparison and activation must keep seeing the catalog's own values.
 */
export function setupModelRowLabel(model: BackendModelDescriptor): string {
  return isAutomaticOpenRouterRoute(model)
    ? "Automatic routing · OpenRouter picks per request · price dynamic"
    : model.displayName;
}

function compatibleMainModels(
  backendId: "openrouter" | "kimi-code",
  models: readonly BackendModelDescriptor[],
): BackendModelDescriptor[] {
  return models.filter((model) =>
    model.backendId === backendId
    && isSetupMainModelCandidate(model),
  ).filter((model) => backendId !== "kimi-code" || (
    KIMI_SETUP_MODEL_IDS.has(model.requestedModelId)
    && model.requestedModelId === model.canonicalModelId
  ));
}

/**
 * FIX-12: the exact set of backends this flow can carry all the way to a
 * working route. `runSetupHub`'s selection guard and `hubEntries` both go
 * through it, so the hub can never list a row the flow below would refuse.
 */
function isRunnableSetupBackend(id: BackendId): id is "openrouter" | "kimi-code" {
  return id === "openrouter" || id === "kimi-code";
}

function hubEntries(
  registry: BackendRegistry,
  stateStore: ProviderStateStore,
  environmentOffered: boolean,
  savedCredentialUnavailable = false,
): SetupHubEntry[] {
  const state = stateStore.read();
  const entries: SetupHubEntry[] = [];
  const unavailable: SetupHubEntry[] = [];
  for (const descriptor of registry.entries()) {
    // FIX-12: the synthesized "Codex · Coming soon is not selectable" row
    // is gone. `codex` has no descriptor to speak for — `BackendRegistry`'s
    // constructor throws on any attempt to register it — so that row was
    // fabricated out of nothing to announce that nothing was coming.
    if (!isRunnableSetupBackend(descriptor.id)) {
      // `anthropic` keeps its row (controller ruling, FIX-13's finding):
      // it is a real registered descriptor and the only backend reaching
      // `/provider`'s coming-soon funnel, so the row is where an owner
      // hunting for Claude actually looks. What it says changes — see
      // `ANTHROPIC_DIRECT_BACKEND_NOTICE`: no promise, one working route.
      if (descriptor.id === "anthropic") {
        unavailable.push({
          id: descriptor.id,
          label: "Anthropic / Claude",
          description: ANTHROPIC_DIRECT_BACKEND_NOTICE,
          disabled: true,
          current: false,
          generation: state.revision,
        });
      }
      continue;
    }
    if (!descriptor.connectable) continue;
    const presentation = descriptor.id === "openrouter"
      // FIX-18 (F4): a configured connection whose key is unreadable must
      // not present itself as an intact account — the row states the honest
      // state and the way out instead.
      ? savedCredentialUnavailable
        ? { label: "OpenRouter", description: "Key missing — enter it again" }
        : { label: "OpenRouter", description: "API key · Pay as you go · Many models" }
      : {
        label: "Kimi Code membership",
        // FIX-12: the trailing "· OAuth coming soon" is gone — no OAuth
        // implementation exists anywhere in the tree, for any backend, so
        // it announced an intention rather than a feature. The membership
        // key simply IS the method, which the row already says. (FIX-18's
        // merge kept this ruling; unavailable backends render through the
        // separate redirect-row mechanism, never a "coming soon" claim.)
        description: "Membership key · Provider-managed limits",
      };
    entries.push({
      id: descriptor.id,
      label: presentation.label,
      description: presentation.description,
      disabled: false,
      current: state.defaultRoute?.backendId === descriptor.id,
      generation: state.revision,
    });
  }
  if (environmentOffered) {
    entries.push({
      id: "openrouter:environment",
      label: "OpenRouter · Environment",
      description: "Use for this process only",
      disabled: false,
      current: false,
      generation: state.revision,
    });
  }
  // Connectable rows first, then the one row that redirects rather than
  // connects — no surface can pick it (every `chooseHub` filters `disabled`).
  return [...entries, ...unavailable];
}

function descriptorFor(registry: BackendRegistry, id: string): BackendDescriptor | null {
  return registry.entries().find((descriptor) => descriptor.id === id) ?? null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * F7 (ruling 3): a safe, non-fabricated stand-in for "the existing key" in
 * the Kimi replace-consequence copy. `accountFingerprint` is an HMAC of the
 * credential (`kimi-code-backend.ts`'s `#fingerprint`), never the raw secret
 * itself, so its tail can never leak a fragment of the actual key — unlike
 * the raw secret, showing it can never trip the "no secret in transcript"
 * honesty gate. Matches the existing `…<tail>` convention already used for
 * account identity elsewhere (`cli.ts`'s `accountFingerprintSuffix`).
 */
function maskedAccountTail(accountFingerprint: string): string {
  return `…${accountFingerprint.slice(-6)}`;
}

/**
 * FIX-14 ticket 5: the `busy` boolean is derived from the ONE notice
 * vocabulary (`NoticeKind`, types.ts) rather than being a third, private
 * idea of what a notice is. The wire shape stays as it is — several surface
 * adapters (cli.ts, tui.ts) already read `busy`/`outcome` — but the CHOICE
 * a caller makes is now the shared `kind`, so a setup notice and a settings
 * notice cannot mean different things by the same word.
 */
function notice(
  message: string,
  kind: NoticeKind = "info",
): { version: 1; type: "notice"; message: string; busy: boolean } {
  return { version: 1, type: "notice", message, busy: kind === "busy" };
}

/**
 * FIX-18: a settled outcome of a setup attempt — success, a named failure
 * with its reason, or an explicit cancel. Every surface adapter renders
 * these durably (chat transcript / direct line), never only on a status
 * line the next prompt clobbers.
 */
function outcomeNotice(
  message: string,
  title?: string,
): { version: 1; type: "notice"; message: string; busy: false; outcome: true; title?: string } {
  return {
    version: 1,
    type: "notice",
    message,
    busy: false,
    outcome: true,
    ...(title ? { title } : {}),
  };
}

/**
 * FIX-18: one honest line per blocked exit. `/provider setup` is named as
 * the next step because a blocked setup drops the user back into a chat
 * where that command is the one working way to start over (the same next
 * step every provider-missing refusal names).
 */
function blockedOutcomeMessage(reason: SetupBlockedReason): string {
  switch (reason) {
    case "stale":
      return "Provider setup stopped: the attempt is no longer current. Run /provider setup to try again.";
    case "forget-pending":
      return "Provider setup stopped: a previous disconnect is still being cleaned up. Run /provider setup to try again.";
    case "unavailable":
      return "Provider setup is not available in this session. No account was connected.";
    case "recovery-required":
      return "Provider setup failed before it could finish. No account was connected — run /provider setup to try again.";
  }
}

function providerState(entries: readonly SetupHubEntry[]): SetupProviderStatePresentation {
  return { version: 1, type: "provider-state", entries: [...entries] };
}

function providerEntryLabel(entry: SetupHubEntry): string {
  // `entry.generation` is an internal retry-round counter (V3 audit
  // principle 4, mirrors `providerAccountCommand`'s `reconnected` result in
  // commands.ts) — it drives `statusGeneration` staleness tracking below,
  // never the label text.
  //
  // PLAIN SURFACE ONLY: the fullscreen sites hand `current` to
  // `ui.pickChoice`, whose row renderer already marks that row (list-core's
  // `· active`) — a second "· Current" in the label doubled the marking with
  // a second word for the same fact. The plain picker has no current-row
  // mechanism of its own, so here the suffix IS the marking, in the picker's
  // own vocabulary.
  return entry.current ? `${entry.label} · active` : entry.label;
}

/**
 * Fix round 1, Critical C1: `TerminalUi.addMessage`'s own notice rendering
 * (`render-block.ts`'s `"notice"` case) only wraps the part AFTER the first
 * newline (the "cause", via `markdownToLines`) — the part BEFORE it (the
 * "title") is one fixed-width line that truncates instead of wrapping. A
 * long pre-secret disclosure passed as a single unbroken line would
 * silently lose its tail exactly the same way the bug this fixes did.
 * Splitting on the secret prompt's own short label keeps the title
 * comfortably short and puts the full notice text in the wrapped cause
 * instead, so nothing is cut off regardless of terminal width.
 */
function transcriptNoticeContent(secretLabel: string, notice: string): string {
  return `${secretLabel}\n${notice}`;
}

/**
 * FIX-18: same C1 rule for settled outcomes — a long outcome carries a short
 * headline as the (truncating) title and the full message on the wrapped
 * cause lines; a short outcome stays a plain one-line title.
 */
function outcomeTranscriptContent(event: { message: string; title?: string }): string {
  return event.title ? `${event.title}\n${event.message}` : event.message;
}

export interface PlainSetupPromptIo {
  /**
   * `null` on Escape/Ctrl+C (the list-core plain picker's cancel contract — never a throw).
   *
   * FIX-12: `description` is separate from `name` rather than pre-joined
   * into it, so the picker itself can lay each provider out as a row —
   * name first, its facts muted beside it — instead of the caller flattening
   * both into one string the row renderer can no longer tell apart.
   */
  select(request: {
    message: string;
    choices: readonly { name: string; value: string; description?: string }[];
  }): Promise<string | null>;
  password(request: { message: string; mask: string }): Promise<string>;
  confirm(request: { message: string; default: boolean }): Promise<boolean>;
  /**
   * FIX-18: prints one settled outcome line (success / named failure /
   * cancel) durably. The prompt-status fold below only shows text when a
   * NEXT prompt opens — a final outcome (e.g. "Setup cancelled.") had no
   * next prompt and was silently dropped. Defaults to stdout.
   */
  printNotice?(message: string): void;
}

/** The CLI supplies the existing Inquirer primitives; this module never does. */
export function createPlainSetupSurface(io: PlainSetupPromptIo): SetupSurface {
  let latestNotice = "";
  let statusGeneration: number | null = null;
  const status = (): string => latestNotice;
  return {
    async chooseHub(entries) {
      const selectable = entries.filter((entry) => !entry.disabled);
      if (selectable.length === 0) return null;
      // FIX-12: a disabled row can never be an action, but it is where an
      // owner hunting for Claude is told where Claude actually runs — so
      // the plain surface has to show it somewhere, the way the fullscreen
      // one does through `presentUnavailable`. Here, on its own line above
      // the picker and only at the moment a provider is being chosen: not
      // folded into the choice list (nothing to choose), and not carried
      // into the secret prompt below, where it would be noise.
      const redirects = entries
        .filter((entry) => entry.disabled)
        .map((entry) => `${entry.label} · ${entry.description}`);
      return io.select({
        // FIX-11: the same screen the two fullscreen surfaces below title
        // "Provider setup" — one name for one screen, whichever surface
        // happens to be rendering it.
        message: promptMessage("Provider setup", [...redirects, status()].filter(Boolean).join("\n")),
        // FIX-12: label and facts stay two fields. Joined into one `name`
        // they reached the row renderer as an opaque string, so a provider
        // and everything true about it were one undifferentiated run of
        // text; kept apart, the picker gives the name its own column and
        // mutes the facts next to it, one provider per row.
        choices: selectable.map((entry) => ({
          name: providerEntryLabel(entry),
          value: entry.id,
          description: entry.description,
        })),
      }).catch(() => null);
    },
    async readSecret(request) {
      // The caller always presents the login-type/cost-boundary disclosure as
      // a notice immediately before this call; fold it in so it is actually
      // shown, the same way chooseHub folds pending status into its prompt.
      return io.password({ message: promptMessage(request.message, status()), mask: "•" }).catch(() => null);
    },
    async chooseModel(request) {
      return io.select({
        message: "Choose a model",
        choices: request.models.map((model) => ({ name: setupModelRowLabel(model), value: model.canonicalModelId })),
      }).catch(() => null);
    },
    async confirm(request) {
      // D4: danger forces the safe default regardless of what the caller
      // asked for — the plain Inquirer primitive itself has no notion of
      // the confirm class, so the adapter is where the rule is enforced.
      const danger = request.danger === true;
      // Fix round 1, MINOR 3: mirrors confirmPlain's danger path — the
      // consequence prints as its own line BEFORE the prompt (so it
      // survives once Inquirer collapses its own prompt line after an
      // answer) instead of being silently dropped. No danger setup site
      // exists today, so this is latent hardening for the next one.
      if (danger && request.consequence) process.stdout.write(`${request.consequence}\n`);
      const useDefault = danger ? false : request.defaultValue;
      return io.confirm({ message: request.message, default: useDefault }).catch(() => false);
    },
    present(event) {
      if (event.type === "provider-state") {
        // The generation is the store revision every entry shares in one
        // snapshot: unchanged means the same retry round, so the notice
        // stays; a new generation starts a fresh round and retires it.
        const generation = event.entries[0]?.generation ?? null;
        if (generation !== statusGeneration) latestNotice = "";
        statusGeneration = generation;
        // FIX-12: the entries themselves are deliberately NOT restated
        // here. `providerStateLabel`'s single `·`-joined line was the first
        // thing this program ever printed to a new owner — a 240-character
        // run-on carrying eleven separators, printed above a picker that
        // then listed the very same providers again, one per row. The
        // picker's rows are the list; the only thing this branch still owes
        // the owner is retiring a notice that belongs to an older round.
      } else if (event.type === "notice") {
        // FIX-18: a settled outcome prints as its own durable line — the
        // prompt fold only ever surfaces text when another prompt opens,
        // so a FINAL outcome (cancel, blocked, success) was silently lost.
        if (event.outcome === true) {
          if (io.printNotice) io.printNotice(event.message);
          else process.stdout.write(`${event.message}\n`);
        } else {
          latestNotice = event.message;
        }
      }
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
  readSecret(label: string, options?: { escHint?: string }): Promise<string | null>;
  pickModel(
    search: (query: string) => readonly ModelInfo[],
    currentModel: string,
    title?: string,
  ): Promise<{ id: string } | null>;
  confirmAction(
    title: string,
    details: string,
    options?: { rememberAvailable?: boolean; danger?: boolean },
  ): Promise<{ accepted: boolean }>;
  addMessage(role: "user" | "assistant" | "system" | "error", content: string, meta?: string): void;
  setStatus(status: string, busy?: boolean): void;
}

/** Keyboard-only setup bridge used while the Settings surface owns the terminal. */
export interface SettingsSetupPromptUi {
  pickChoice(
    title: string,
    items: readonly { label: string; value: string; description: string }[],
    currentValue: string,
    initialValue?: string,
  ): Promise<{ value: string } | null>;
  readSecret(label: string, options?: { escHint?: string }): Promise<string | null>;
  pickModel(
    search: (query: string) => readonly ModelInfo[],
    currentModel: string,
    title?: string,
  ): Promise<{ id: string } | null>;
  confirmAction(
    title: string,
    details: string,
    options?: { rememberAvailable?: boolean; danger?: boolean },
  ): Promise<{ accepted: boolean }>;
  showSettingsNotice(message: string): void;
  restoreSettings(): void;
  /**
   * Fix round 1, Critical C1: `showSettingsNotice` only *stages* text for
   * the chat surface Settings eventually returns to — invisible for as
   * long as Settings (or a nested secret/picker under it) stays open, which
   * is exactly when the pre-secret disclosure most needs to be seen. This
   * is the one durable, surface-agnostic channel (`TerminalUi.addMessage`,
   * already relied on by `createTuiSetupSurface`'s `presentUnavailable`
   * below) that survives the nested secret prompt's own surface switch.
   */
  addMessage(role: "user" | "assistant" | "system" | "error", content: string, meta?: string): void;
}

export function createSettingsSetupSurface(ui: SettingsSetupPromptUi): SetupSurface {
  const restore = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } finally { ui.restoreSettings(); }
  };
  // Fix round 1, Critical C1 (mirrors createTuiSetupSurface's identical
  // field below): the pending pre-secret notice (cost disclosure, and now
  // the Kimi replace consequence) — pushed into the transcript right
  // before the secret prompt opens, since nothing else survives visibly
  // across that surface switch. See the interface doc above for why.
  let pendingSecretNotice: string | null = null;
  return {
    chooseHub(entries) {
      const selectable = entries.filter((entry) => !entry.disabled);
      const current = selectable.find((entry) => entry.current)?.id ?? "";
      const items = selectable.map((entry) => ({
        // `pickChoice` marks the current row itself from `current` below —
        // the bare label avoids the doubled "· Current"/"· active" pair.
        value: entry.id, label: entry.label, description: entry.description,
      }));
      return restore(() => ui.pickChoice("Provider setup", items, current, current || (items[0]?.value ?? ""))
        .then((picked) => picked?.value ?? null));
    },
    readSecret(request) {
      return restore(() => {
        if (pendingSecretNotice) {
          ui.addMessage("system", transcriptNoticeContent(request.message, pendingSecretNotice), "Provider setup");
          pendingSecretNotice = null;
        }
        return ui.readSecret(request.message, { escHint: "Esc back" });
      });
    },
    chooseModel(request) {
      const models = request.models.map(modelInfo);
      return restore(() => ui.pickModel(() => models, "", "Choose a model")
        .then((picked) => picked?.id ?? null));
    },
    confirm(request) {
      // D4: this used to hardcode the danger-style grammar (Enter always
      // declined) regardless of the caller's intent — e.g. the "Save the
      // OpenRouter API key securely?" question wants Enter to accept, and
      // now does, since it never sets `danger`.
      return restore(() => ui.confirmAction(request.message, "", { danger: request.danger === true })
        .then((result) => result.accepted));
    },
    present(event) {
      try {
        // FIX-12: a provider-state snapshot is no longer restated here. It
        // used to print every entry flattened into a single `·`-joined
        // line — the same run-on the plain surface showed — directly above
        // a picker that then laid out those very providers as rows.
        if (event.type === "notice") {
          // FIX-18: a settled outcome goes straight to the durable
          // transcript channel (the same one C1 proved survives nested
          // surface switches); `showSettingsNotice` alone only STAGES text
          // that stays invisible while Settings or a nested prompt is open.
          if (event.outcome === true) {
            ui.addMessage("system", outcomeTranscriptContent(event), "Provider setup");
          } else {
            pendingSecretNotice = event.message;
          }
          ui.showSettingsNotice(event.message);
        }
      } finally {
        ui.restoreSettings();
      }
    },
  };
}

/** The fullscreen UI supplies its existing picker and secret primitives. */
export function createTuiSetupSurface(ui: TuiSetupPromptUi): SetupSurface {
  const presentedUnavailable = new Set<string>();
  const presentUnavailable = (label: string, description: string): void => {
    const key = `${label}\u0000${description}`;
    if (presentedUnavailable.has(key)) return;
    presentedUnavailable.add(key);
    ui.addMessage("system", `${label} · ${description}`, "Provider setup");
  };
  // Fix round 1, Critical C1: `setStatus`'s pending text is clobbered
  // same-tick by `readSecret`'s own mode switch (`TerminalUi.#enterMode`
  // overwrites `#status` before the ~30ms debounced render from `setStatus`
  // ever fires), and the "secret" mode status line is hardcoded to
  // "<label> · input stays hidden" regardless (`dashboard-frame.ts`'s
  // `dashboardStatusLine`) — so the pre-secret disclosure (cost, and now
  // the Kimi replace consequence) was never actually visible here, even
  // though the plain surface's `promptMessage` fold showed it correctly.
  // The one channel proven to survive that switch is the chat transcript
  // (`presentUnavailable`, above, already relies on it for the same class
  // of "must be seen before the next prompt" information) — so the pending
  // notice is pushed there instead, right before the secret prompt opens.
  let pendingSecretNotice: string | null = null;
  return {
    async chooseHub(entries) {
      const selectable = entries.filter((entry) => !entry.disabled);
      if (selectable.length === 0) return null;
      const current = selectable.find((entry) => entry.current)?.id ?? "";
      const items = selectable.map((entry) => ({
        value: entry.id,
        // Same rule as the Settings surface above: `pickChoice` renders the
        // current marking from `current`, the label stays bare.
        label: entry.label,
        description: entry.description,
      }));
      return (await ui.pickChoice("Provider setup", items, current, current || (items[0]?.value ?? "")))?.value ?? null;
    },
    readSecret(request) {
      if (pendingSecretNotice) {
        ui.addMessage("system", transcriptNoticeContent(request.message, pendingSecretNotice), "Provider setup");
        pendingSecretNotice = null;
      }
      // FIX-18 (Esc depth): the setup key stage steps BACK to the provider
      // list on Escape, so its hint must not claim a full cancel.
      return ui.readSecret(request.message, { escHint: "Esc back" });
    },
    async chooseModel(request) {
      const byId = new Map(request.models.map((model) => [model.canonicalModelId, model]));
      const models = [...byId.values()].map(modelInfo);
      const picked = await ui.pickModel(() => models, "", "Choose a model");
      return picked?.id ?? null;
    },
    async confirm(request) {
      // D4: see the identical note on `createSettingsSetupSurface.confirm`.
      return (await ui.confirmAction(request.message, "", { danger: request.danger === true })).accepted;
    },
    present(event) {
      if (event.type === "provider-state") {
        for (const entry of event.entries.filter((entry) => entry.disabled)) {
          presentUnavailable(entry.label, entry.description);
        }
      } else if (event.type === "notice") {
        // FIX-18: a settled outcome (success, named failure, cancel) goes to
        // the chat transcript — the ONE channel proven to survive the next
        // prompt's mode switch. Routing only `Setup cancelled` there via a
        // text regex left every failure outcome ("could not validate the
        // API key", "setup failed") invisible: `setStatus` below is
        // clobbered by the next picker's own status line, and the
        // pending-secret channel only flushes when another secret prompt
        // opens. Pre-prompt disclosures keep that F7 channel unchanged.
        if (event.outcome === true) {
          ui.addMessage("system", outcomeTranscriptContent(event), "Provider setup");
        } else {
          pendingSecretNotice = event.message;
        }
        // `busy: true` (Phase 7) keeps the spinner glyph on `setStatus`'s
        // default while validation is still running; every existing notice
        // keeps passing `false` exactly as before.
        ui.setStatus(event.message, event.busy ?? false);
      }
    },
  };
}

function modelInfo(model: BackendModelDescriptor): ModelInfo {
  return {
    id: model.canonicalModelId,
    name: setupModelRowLabel(model),
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
