import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { RouteIdentityV1 } from "./backends.js";
import {
  isAtomicFilePostPublicationError,
  readConfigFileSnapshot,
  saveConfigEditUnderLock,
  sameConfigFileSnapshot,
  validateConfig,
  withConfigWriteLocks,
  writeFileAtomicSecure,
  type ConfigEditSnapshot,
  type ConfigFileSnapshot,
  type ConfigInput,
  type ConfigWriteOwnership,
  type OrcodeConfigWithBudget,
} from "./config.js";
import {
  PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES,
  PRIVATE_STORE_CLAIM_PAYLOAD_NAMES,
  PrivateStore,
  type PrivateDirectoryClaim,
  type PrivateStoreClaimPayloadName,
} from "./private-store.js";
import {
  isProviderStateIssue,
  validateProviderSetupState,
  validateRouteIdentityV1,
  type ProviderSetupStateV3,
} from "./provider-state.js";
import {
  saveSessionEditUnderLock,
  validateSessionEditBytes,
  type PersistedSessionData,
  type SessionEditSnapshot,
} from "./session.js";
import { isRecord } from "./utils.js";
import {
  createProviderPreferenceCommitPort,
  type ProviderPreferenceCommitPort,
  type ProviderPreferenceCleanupAck,
  type ProviderPreferenceCleanupAuthority,
  type ProviderPreferenceCompletionAck,
  type ProviderPreferenceMutationAuthority,
  type ProviderPreferenceReconcileResult,
} from "./provider-activation.js";

export const MODEL_PREFERENCE_TRANSACTION_VERSION = 1 as const;
const MODEL_PREFERENCE_DIRECTORY = "transactions/model-preference";
const MODEL_PREFERENCE_QUARANTINE_DIRECTORY = "transactions/model-preference-quarantine";
const MANIFEST_LIMIT = 65_536;
const MAX_PATH_LENGTH = 4_096;
const MAX_CONNECTION_ID_LENGTH = 512;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const MODEL_PREFERENCE_FAILPOINTS = [
  "before-provider-preparation",
  "after-provider-preparation",
  "before-journal-create",
  "after-journal-create",
  "before-config-cas",
  "after-config-cas",
  "before-session-write",
  "after-session-write",
  "before-preferences-durable",
  "after-preferences-durable",
  "before-provider-commit",
  "after-provider-commit",
  "before-route-durable",
  "after-route-durable",
  "before-live-publish",
  "after-live-publish",
  "before-committed",
  "after-committed",
  "before-journal-remove",
  "after-journal-remove",
] as const;

export type ModelPreferenceFailpoint = (typeof MODEL_PREFERENCE_FAILPOINTS)[number];

export type ModelPreferencePhase =
  | "prepared"
  | "preferences-durable"
  | "route-durable"
  | "committed";

export interface ModelPreferencePayloadDescriptor {
  readonly name: PrivateStoreClaimPayloadName;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ModelPreferenceAuthorityIdentity {
  readonly route: RouteIdentityV1;
  readonly providerRevision: number;
  readonly connectionId: string;
}

export interface ModelPreferenceDurableTuple {
  readonly config: ModelPreferencePayloadDescriptor;
  readonly session: ModelPreferencePayloadDescriptor;
  readonly authority: ModelPreferenceAuthorityIdentity;
}

export interface ModelPreferenceStagingDescriptor {
  readonly configBytes: number;
  readonly configSha256: string;
  readonly sessionBytes: number;
  readonly sessionSha256: string;
}

export interface ModelPreferenceTransactionV1 {
  readonly version: 1;
  readonly transactionId: string;
  readonly phase: ModelPreferencePhase;
  readonly configPath: string;
  readonly sessionPath: string;
  readonly before: ModelPreferenceDurableTuple;
  readonly after: ModelPreferenceDurableTuple;
  readonly staging: ModelPreferenceStagingDescriptor;
}

export interface ModelPreferenceAuthoritySnapshot {
  readonly route: RouteIdentityV1 | null;
  readonly providerRevision: number;
  readonly connectionId: string | null;
}

export interface ModelPreferenceRouteAuthority {
  /** Must be called while the existing provider coordinator authority is held. */
  read(): Promise<ModelPreferenceAuthoritySnapshot>;
  /**
   * Production supplies the existing provider transition. It invokes
   * `persist` exactly once while Runtime -> Provider authority is held and
   * before its provider-config CAS, then consumes the returned exact fence.
   */
  commit?(
    route: RouteIdentityV1,
    publication: ModelPreferenceAuthorityPublication,
  ): Promise<void>;
}

export interface ModelPreferenceRouteAuthorityBridgeInput<TSurface = unknown> {
  readonly read: () =>
    | ModelPreferenceAuthoritySnapshot
    | Promise<ModelPreferenceAuthoritySnapshot>;
  readonly transition: (
    route: RouteIdentityV1,
    publication: ProviderPreferenceCommitPort,
    surface: TSurface | undefined,
  ) => Promise<RouteIdentityV1>;
  readonly surface?: TSurface;
  readonly invalidError?: () => Error;
}

export interface ModelPreferenceAuthorityPublication {
  persist(
    nextProviderState: ProviderSetupStateV3,
    authority: ProviderPreferenceMutationAuthority,
  ): Promise<ModelPreferenceStagingFence>;
  abortAndReconcile(
    authority: ProviderPreferenceMutationAuthority,
  ): Promise<ProviderPreferenceReconcileResult>;
  complete(
    authority: ProviderPreferenceMutationAuthority,
  ): Promise<ProviderPreferenceCompletionAck>;
  cleanup(
    authority: ProviderPreferenceCleanupAuthority,
  ): Promise<ProviderPreferenceCleanupAck>;
}

export interface ModelPreferenceStagingFence {
  readonly configFence: ConfigFileSnapshot;
}

export interface RunModelPreferenceTransactionInput {
  readonly appHome: string;
  readonly configPath: string;
  readonly sessionPath: string;
  readonly expectedConfig: ConfigEditSnapshot;
  readonly nextConfig:
    | ConfigInput
    | ((nextProviderState: ProviderSetupStateV3) => ConfigInput);
  readonly expectedSession: SessionEditSnapshot;
  readonly nextSession: PersistedSessionData;
  readonly beforeRoute: RouteIdentityV1;
  readonly afterRoute: RouteIdentityV1;
  readonly routeAuthority: ModelPreferenceRouteAuthority;
  readonly publish: (route: RouteIdentityV1) => void;
  /** Test-only synchronous crash selector; never invokes code under writer locks. */
  readonly failpoint?: ModelPreferenceFailpoint;
}

export interface RecoverModelPreferenceTransactionsInput {
  readonly appHome: string;
  readonly routeAuthority: Pick<ModelPreferenceRouteAuthority, "read"> & {
    /** Existing Runtime -> Provider lease fence; recovery owns no coordinator. */
    assertHeld(): Promise<void>;
  };
  readonly allowedBackendIds?: readonly ("openrouter" | "kimi-code" | "nano-gpt")[];
}

export interface RecoveredModelPreferenceOwner {
  readonly configPath: string;
  readonly sessionPath: string;
}

export class ModelPreferenceCrashError extends Error {
  constructor(readonly failpoint: ModelPreferenceFailpoint) {
    super(`Simulated model preference crash at ${failpoint}.`);
    this.name = "ModelPreferenceCrashError";
  }
}

export class ModelPreferencePayloadTooLargeError extends Error {
  readonly code = "model-preference-payload-too-large" as const;

  constructor() {
    super("Model preference transaction payload exceeds its private size limit.");
    this.name = "ModelPreferencePayloadTooLargeError";
  }
}

export class ModelPreferenceRecoveryRequiredError extends Error {
  readonly code = "model-preference-recovery-required" as const;

  constructor() {
    super("Model preference transaction requires exact recovery.");
    this.name = "ModelPreferenceRecoveryRequiredError";
  }
}

/**
 * Creates the sole adapter from the exact preference journal authority into
 * the provider coordinator's opaque, one-shot publication port.
 */
export function createModelPreferenceRouteAuthorityBridge<TSurface = unknown>(
  input: ModelPreferenceRouteAuthorityBridgeInput<TSurface>,
): ModelPreferenceRouteAuthority {
  const invalid = input.invalidError ?? (() => new ModelPreferenceRecoveryRequiredError());
  if (typeof input.read !== "function"
    || typeof input.transition !== "function"
    || typeof invalid !== "function") {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  let commitCalled = false;
  return Object.freeze({
    async read() {
      return structuredClone(await input.read());
    },
    async commit(
      route: RouteIdentityV1,
      publication: ModelPreferenceAuthorityPublication,
    ) {
      if (commitCalled) throw invalid();
      commitCalled = true;
      const port = createProviderPreferenceCommitPort({
        persist: async ({ state }, authority) => {
          const staged = await publication.persist(state, authority);
          return authority.acknowledgePersistence(staged.configFence);
        },
        abortAndReconcile: (authority) => publication.abortAndReconcile(authority),
        complete: (_candidate, authority) => publication.complete(authority),
        cleanup: (authority) => publication.cleanup(authority),
      });
      const committed = await input.transition(
        structuredClone(route),
        port,
        input.surface,
      );
      if (!sameExactModelPreferenceRoute(committed, route)) throw invalid();
    },
  });
}

interface PreparedTransaction {
  readonly manifest: ModelPreferenceTransactionV1;
  readonly rawManifest: string;
  readonly payloads: Readonly<Record<PrivateStoreClaimPayloadName, string>>;
  readonly stagingConfig: OrcodeConfigWithBudget;
  readonly stagingConfigRaw: string;
  readonly finalConfig: OrcodeConfigWithBudget;
  readonly finalConfigRaw: string;
  readonly finalSessionRaw: string;
}

interface JournalHandle {
  readonly store: PrivateStore;
  readonly path: string;
  readonly claim: PrivateDirectoryClaim;
  manifest: ModelPreferenceTransactionV1;
  rawManifest: string;
  readonly payloads: Readonly<Record<PrivateStoreClaimPayloadName, string>>;
}

/**
 * Executes the recoverable OLD -> STAGING -> FINAL publication protocol.
 * The route authority supplied by production must be the existing provider
 * coordinator/state path; this module owns no provider lock or coordinator.
 */
export async function runModelPreferenceTransaction(
  input: RunModelPreferenceTransactionInput,
): Promise<RouteIdentityV1> {
  assertTransactionPreflight(input);
  const nextConfigInput = input.nextConfig;
  let prepared = typeof nextConfigInput === "function"
    ? null
    : prepareTransaction(input, nextConfigInput);
  hit(input, "before-provider-preparation");

  let journal: JournalHandle | null = null;
  let persistCalled = false;
  let completionCalled = false;
  let cleanupCalled = false;
  let transactionCompleted = false;
  let mutationAuthority: ProviderPreferenceMutationAuthority | null = null;
  let mutationBegun = false;
  let persistFinished = false;
  let resolvePersistFinished!: () => void;
  const persistFinishedPromise = new Promise<void>((resolveFinished) => {
    resolvePersistFinished = resolveFinished;
  });
  const abortState: {
    settlement: Promise<ProviderPreferenceReconcileResult> | null;
  } = { settlement: null };
  const publication: ModelPreferenceAuthorityPublication = Object.freeze({
    async persist(
      nextProviderState: ProviderSetupStateV3,
      authority: ProviderPreferenceMutationAuthority,
    ) {
      if (persistCalled || mutationAuthority !== null) {
        throw new ModelPreferenceRecoveryRequiredError();
      }
      persistCalled = true;
      mutationAuthority = authority;
      try {
        authority.assertMutationAllowed();
        hit(input, "after-provider-preparation");
        const callbackPrepared = prepared ?? (typeof nextConfigInput === "function"
          ? prepareTransaction(input, nextConfigInput(nextProviderState))
          : null);
        if (!callbackPrepared) throw new ModelPreferenceRecoveryRequiredError();
        prepared = callbackPrepared;
        if (!isDeepStrictEqual(
          nextProviderState,
          callbackPrepared.finalConfig.providerSetup,
        )) {
          throw new ModelPreferenceRecoveryRequiredError();
        }
        await authority.assertMutationAuthorityHeld();
        mutationBegun = true;
        let configFence: ConfigFileSnapshot | null = null;
        await withPreferenceLocks(input.configPath, input.sessionPath, async (
          configOwnership,
          sessionOwnership,
        ) => {
          await authority.assertMutationAuthorityHeld();
          await assertInitialSnapshots(input, configOwnership, sessionOwnership);
          await authority.assertMutationAuthorityHeld();
          hit(input, "before-journal-create");
          authority.assertMutationAllowed();
          journal = await createJournal(
            input.appHome,
            callbackPrepared,
            () => authority.assertMutationAuthorityHeld(),
          );
          await authority.assertMutationAuthorityHeld();
          hit(input, "after-journal-create");

          hit(input, "before-config-cas");
          await authority.assertMutationAuthorityHeld();
          await saveConfigEditUnderLock(
            configOwnership,
            input.expectedConfig,
            callbackPrepared.stagingConfig,
          );
          await authority.assertMutationAuthorityHeld();
          configFence = await assertRaw(
            configOwnership,
            callbackPrepared.stagingConfigRaw,
          );
          await authority.assertMutationAuthorityHeld();
          hit(input, "after-config-cas");

          hit(input, "before-session-write");
          await authority.assertMutationAuthorityHeld();
          await saveSessionEditUnderLock(
            sessionOwnership,
            input.expectedSession,
            input.nextSession,
          );
          await authority.assertMutationAuthorityHeld();
          await assertRaw(sessionOwnership, callbackPrepared.finalSessionRaw);
          await authority.assertMutationAuthorityHeld();
          hit(input, "after-session-write");

          hit(input, "before-preferences-durable");
          authority.assertMutationAllowed();
          journal = await advanceJournal(
            journal!,
            "prepared",
            "preferences-durable",
            () => authority.assertMutationAuthorityHeld(),
          );
          await authority.assertMutationAuthorityHeld();
          hit(input, "after-preferences-durable");
        });
        await authority.assertMutationAuthorityHeld();
        hit(input, "before-provider-commit");
        if (!configFence) throw new ModelPreferenceRecoveryRequiredError();
        return { configFence };
      } finally {
        persistFinished = true;
        resolvePersistFinished();
      }
    },
    abortAndReconcile(authority: ProviderPreferenceMutationAuthority) {
      if (abortState.settlement) return abortState.settlement;
      abortState.settlement = (async (): Promise<ProviderPreferenceReconcileResult> => {
        if (authority !== mutationAuthority) {
          return Object.freeze({ kind: "recovery-required" as const });
        }
        await authority.assertReconcileAuthorityHeld();
        if (mutationBegun && !persistFinished) {
          await persistFinishedPromise;
          await authority.assertReconcileAuthorityHeld();
        }
        if (!journal || !prepared) {
          return Object.freeze({ kind: "old" as const });
        }
        const disposition = await classifyJournalFiles(
          journal,
          prepared,
          () => authority.assertReconcileAuthorityHeld(),
        );
        await authority.assertReconcileAuthorityHeld();
        if (disposition === "final") {
          return Object.freeze({ kind: "final" as const });
        }
        if (disposition !== "recoverable-old") {
          return Object.freeze({ kind: "recovery-required" as const });
        }
        await convergeJournal(
          journal,
          prepared,
          "before",
          () => authority.assertReconcileAuthorityHeld(),
        );
        await authority.assertReconcileAuthorityHeld();
        await removeJournal(journal, () => authority.assertReconcileAuthorityHeld());
        await authority.assertReconcileAuthorityHeld();
        journal = null;
        return Object.freeze({ kind: "old" as const });
      })().catch(() => Object.freeze({ kind: "recovery-required" as const }));
      return abortState.settlement;
    },
    async complete(authority: ProviderPreferenceMutationAuthority) {
      if (completionCalled
        || authority !== mutationAuthority
        || !persistFinished
        || !journal
        || !prepared) {
        throw new ModelPreferenceRecoveryRequiredError();
      }
      completionCalled = true;
      await authority.assertCompletionAuthorityHeld();
      hit(input, "after-provider-commit");
      authority.assertCompletionAllowed();

      const authoritative = await readAuthority(input.routeAuthority, prepared.manifest);
      await authority.assertCompletionAuthorityHeld();
      if (authoritative !== "after") throw new ModelPreferenceRecoveryRequiredError();
      await convergeJournal(
        journal,
        prepared,
        "after",
        () => authority.assertCompletionAuthorityHeld(),
      );
      await authority.assertCompletionAuthorityHeld();

      hit(input, "before-route-durable");
      authority.assertCompletionAllowed();
      journal = await advanceJournal(
        journal,
        "preferences-durable",
        "route-durable",
        () => authority.assertCompletionAuthorityHeld(),
      );
      await authority.assertCompletionAuthorityHeld();
      hit(input, "after-route-durable");

      hit(input, "before-live-publish");
      await authority.assertCompletionAuthorityHeld();
      authority.assertCompletionAllowed();
      input.publish(structuredClone(input.afterRoute));
      authority.assertCompletionAllowed();
      hit(input, "after-live-publish");

      hit(input, "before-committed");
      authority.assertCompletionAllowed();
      journal = await advanceJournal(
        journal,
        "route-durable",
        "committed",
        () => authority.assertCompletionAuthorityHeld(),
      );
      await authority.assertCompletionAuthorityHeld();
      hit(input, "after-committed");
      return authority.acknowledgeCompletion();
    },
    async cleanup(authority: ProviderPreferenceCleanupAuthority) {
      if (cleanupCalled
        || !completionCalled
        || transactionCompleted
        || !journal
        || !prepared) {
        throw new ModelPreferenceRecoveryRequiredError();
      }
      cleanupCalled = true;
      await authority.assertCleanupAuthorityHeld();
      hit(input, "before-journal-remove");
      await removeJournal(journal, () => authority.assertCleanupAuthorityHeld());
      journal = null;
      hit(input, "after-journal-remove");
      transactionCompleted = true;
      return authority.acknowledgeCleanup();
    },
  });
  try {
    if (!input.routeAuthority.commit) throw new ModelPreferenceRecoveryRequiredError();
    await input.routeAuthority.commit(
      structuredClone(input.afterRoute),
      publication,
    );
    if (!persistCalled
      || !completionCalled
      || !cleanupCalled
      || !transactionCompleted
      || !prepared
      || journal) {
      throw new ModelPreferenceRecoveryRequiredError();
    }
    return structuredClone(input.afterRoute);
  } catch (error) {
    if (error instanceof ModelPreferenceCrashError) throw error;
    if (mutationBegun) {
      if (!abortState.settlement) throw new ModelPreferenceRecoveryRequiredError();
      const outcome = await abortState.settlement;
      if (outcome.kind !== "old") {
        throw new ModelPreferenceRecoveryRequiredError();
      }
      throw error;
    }
    throw error;
  }
}

/** Startup recovery: durable files only; never calls a UI/live publication seam. */
export async function recoverModelPreferenceTransactions(
  input: RecoverModelPreferenceTransactionsInput,
): Promise<readonly RecoveredModelPreferenceOwner[]> {
  await input.routeAuthority.assertHeld();
  const journals = await scanJournals(input.appHome);
  await input.routeAuthority.assertHeld();
  if (journals.length > 1) throw new ModelPreferenceRecoveryRequiredError();
  const recovered: RecoveredModelPreferenceOwner[] = [];
  for (const journal of journals) {
    if (input.allowedBackendIds
      && (!input.allowedBackendIds.some((backendId) =>
        backendId === journal.manifest.before.authority.route.backendId)
        || !input.allowedBackendIds.some((backendId) =>
          backendId === journal.manifest.after.authority.route.backendId))) {
      throw new ModelPreferenceRecoveryRequiredError();
    }
    const prepared = preparedFromJournal(journal);
    const authority = await readRecoveryAuthority(input.routeAuthority, journal.manifest);
    await convergeJournal(
      journal,
      prepared,
      authority,
      () => input.routeAuthority.assertHeld(),
    );
    const stableAuthority = await readRecoveryAuthority(
      input.routeAuthority,
      journal.manifest,
    );
    if (stableAuthority !== authority) throw new ModelPreferenceRecoveryRequiredError();
    const files = await classifyExactJournalFiles(
      journal,
      prepared,
      () => input.routeAuthority.assertHeld(),
    );
    if (files !== authority) throw new ModelPreferenceRecoveryRequiredError();
    if (journal.manifest.phase !== "committed") {
      await input.routeAuthority.assertHeld();
      journal.manifest = { ...journal.manifest, phase: "committed" };
      const nextRaw = serializeManifest(journal.manifest);
      await journal.store.writeClaimManifest(journal.claim, nextRaw, journal.rawManifest);
      await input.routeAuthority.assertHeld();
      journal.rawManifest = nextRaw;
    }
    const finalAuthority = await readRecoveryAuthority(
      input.routeAuthority,
      journal.manifest,
    );
    if (finalAuthority !== authority) throw new ModelPreferenceRecoveryRequiredError();
    const finalFiles = await classifyExactJournalFiles(
      journal,
      prepared,
      () => input.routeAuthority.assertHeld(),
    );
    if (finalFiles !== authority) throw new ModelPreferenceRecoveryRequiredError();
    await removeJournal(journal, () => input.routeAuthority.assertHeld());
    recovered.push(Object.freeze({
      configPath: journal.manifest.configPath,
      sessionPath: journal.manifest.sessionPath,
    }));
  }
  return Object.freeze(recovered);
}

function assertTransactionPreflight(input: RunModelPreferenceTransactionInput): void {
  const appHome = resolve(input.appHome);
  const configPath = resolve(input.configPath);
  const sessionPath = resolve(input.sessionPath);
  if (!isAbsolute(input.appHome)
    || !isAbsolute(input.configPath)
    || !isAbsolute(input.sessionPath)
    || appHome !== input.appHome
    || configPath !== input.configPath
    || sessionPath !== input.sessionPath
    || configPath === sessionPath
    || !isContainedPath(appHome, configPath)
    || !isContainedPath(appHome, sessionPath)
    || hasControl(appHome)
    || hasControl(configPath)
    || hasControl(sessionPath)
    || configPath.length > MAX_PATH_LENGTH
    || sessionPath.length > MAX_PATH_LENGTH
    || input.expectedConfig.file.kind !== "file"
    || input.expectedSession.file.kind !== "file"
    || input.expectedSession.path !== sessionPath) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  const beforeRoute = exactResolvedRoute(input.beforeRoute);
  const afterRoute = exactResolvedRoute(input.afterRoute);
  if (sameExactModelPreferenceRoute(beforeRoute, afterRoute)) {
    throw new Error("Model preference route identity is invalid.");
  }

  authorityFromConfig(input.expectedConfig.config, beforeRoute);
  assertSessionTuple(input.expectedSession.data, beforeRoute);
  assertSessionTuple(input.nextSession, afterRoute);
  const finalSessionRaw = canonicalJson(input.nextSession);
  const parsedSession = validateSessionEditBytes(finalSessionRaw);
  if (!isDeepStrictEqual(parsedSession, input.nextSession)) {
    throw new Error("Model preference session candidate is invalid.");
  }
  assertPayloadSize(input.expectedConfig.file.raw);
  assertPayloadSize(input.expectedSession.file.raw);
  assertPayloadSize(finalSessionRaw);
  if (digest(input.expectedConfig.file.raw) !== input.expectedConfig.file.digest
    || digest(input.expectedSession.file.raw) !== input.expectedSession.file.digest) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
}

function prepareTransaction(
  input: RunModelPreferenceTransactionInput,
  resolvedNextConfig: ConfigInput,
): PreparedTransaction {
  const configPath = resolve(input.configPath);
  const sessionPath = resolve(input.sessionPath);
  const expectedConfigFile = input.expectedConfig.file;
  if (expectedConfigFile.kind !== "file") {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  const beforeRoute = exactResolvedRoute(input.beforeRoute);
  const afterRoute = exactResolvedRoute(input.afterRoute);

  const finalConfig = validateConfig(resolvedNextConfig);
  if (!isDeepStrictEqual(finalConfig, resolvedNextConfig)) {
    throw new Error("Model preference config candidate is invalid.");
  }
  const beforeAuthority = authorityFromConfig(input.expectedConfig.config, beforeRoute);
  const afterAuthority = authorityFromConfig(finalConfig, afterRoute);
  if (afterAuthority.providerRevision !== beforeAuthority.providerRevision + 1) {
    throw new Error("Model preference provider revision is invalid.");
  }
  assertSessionTuple(input.expectedSession.data, beforeRoute);
  assertSessionTuple(input.nextSession, afterRoute);

  const stagingConfig = validateConfig({
    ...structuredClone(finalConfig),
    providerSetup: structuredClone(input.expectedConfig.config.providerSetup),
  });
  const beforeConfigRaw = expectedConfigFile.raw;
  const beforeSessionRaw = input.expectedSession.file.raw;
  const stagingConfigRaw = canonicalJson(stagingConfig);
  const finalConfigRaw = replaceTopLevelJsonValue(
    stagingConfigRaw,
    "providerSetup",
    JSON.stringify(finalConfig.providerSetup),
  );
  const finalSessionRaw = canonicalJson(input.nextSession);
  const parsedSession = validateSessionEditBytes(finalSessionRaw);
  if (!isDeepStrictEqual(parsedSession, input.nextSession)) {
    throw new Error("Model preference session candidate is invalid.");
  }
  const payloads = Object.freeze({
    "before-config.json": beforeConfigRaw,
    "after-config.json": finalConfigRaw,
    "before-session.json": beforeSessionRaw,
    "after-session.json": finalSessionRaw,
  });
  for (const value of Object.values(payloads)) assertPayloadSize(value);

  const transactionId = randomUUID();
  const manifest: ModelPreferenceTransactionV1 = {
    version: 1,
    transactionId,
    phase: "prepared",
    configPath,
    sessionPath,
    before: {
      config: payloadDescriptor("before-config.json", beforeConfigRaw),
      session: payloadDescriptor("before-session.json", beforeSessionRaw),
      authority: beforeAuthority,
    },
    after: {
      config: payloadDescriptor("after-config.json", finalConfigRaw),
      session: payloadDescriptor("after-session.json", finalSessionRaw),
      authority: afterAuthority,
    },
    staging: {
      configBytes: byteLength(stagingConfigRaw),
      configSha256: digest(stagingConfigRaw),
      sessionBytes: byteLength(finalSessionRaw),
      sessionSha256: digest(finalSessionRaw),
    },
  };
  const rawManifest = serializeManifest(manifest);
  if (!isDeepStrictEqual(
    parseManifest(rawManifest, transactionId, resolve(input.appHome)),
    manifest,
  )) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  return {
    manifest,
    rawManifest,
    payloads,
    stagingConfig,
    stagingConfigRaw,
    finalConfig,
    finalConfigRaw,
    finalSessionRaw,
  };
}

function preparedFromJournal(journal: JournalHandle): PreparedTransaction {
  const beforeConfigRaw = journal.payloads["before-config.json"];
  const afterConfigRaw = journal.payloads["after-config.json"];
  const afterSessionRaw = journal.payloads["after-session.json"];
  const beforeConfig = parseConfigPayload(beforeConfigRaw);
  const finalConfig = parseConfigPayload(afterConfigRaw);
  const finalSession = validateSessionEditBytes(afterSessionRaw);
  if (afterSessionRaw !== canonicalJson(finalSession)) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  const stagingConfig = validateConfig({
    ...structuredClone(finalConfig),
    providerSetup: structuredClone(beforeConfig.providerSetup),
  });
  const stagingConfigRaw = canonicalJson(stagingConfig);
  const expectedFinalConfigRaw = replaceTopLevelJsonValue(
    stagingConfigRaw,
    "providerSetup",
    JSON.stringify(finalConfig.providerSetup),
  );
  if (afterConfigRaw !== expectedFinalConfigRaw) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  if (digest(stagingConfigRaw) !== journal.manifest.staging.configSha256
    || byteLength(stagingConfigRaw) !== journal.manifest.staging.configBytes
    || digest(afterSessionRaw) !== journal.manifest.staging.sessionSha256
    || byteLength(afterSessionRaw) !== journal.manifest.staging.sessionBytes) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  assertSessionTuple(
    validateSessionEditBytes(journal.payloads["before-session.json"]),
    journal.manifest.before.authority.route,
  );
  assertSessionTuple(finalSession, journal.manifest.after.authority.route);
  if (!isDeepStrictEqual(
    authorityFromConfig(beforeConfig, journal.manifest.before.authority.route),
    journal.manifest.before.authority,
  ) || !isDeepStrictEqual(
    authorityFromConfig(finalConfig, journal.manifest.after.authority.route),
    journal.manifest.after.authority,
  )) throw new ModelPreferenceRecoveryRequiredError();
  return {
    manifest: journal.manifest,
    rawManifest: journal.rawManifest,
    payloads: journal.payloads,
    stagingConfig,
    stagingConfigRaw,
    finalConfig,
    finalConfigRaw: afterConfigRaw,
    finalSessionRaw: afterSessionRaw,
  };
}

async function createJournal(
  appHome: string,
  prepared: PreparedTransaction,
  assertAuthority: () => void | Promise<void> = () => undefined,
): Promise<JournalHandle> {
  const root = join(appHome, MODEL_PREFERENCE_DIRECTORY);
  const path = join(root, prepared.manifest.transactionId);
  const store = new PrivateStore({ root: appHome });
  await assertAuthority();
  await store.ensureDirectory(root);
  await assertAuthority();
  const claim = await store.createDirectoryExclusive(path);
  if (!claim) throw new ModelPreferenceRecoveryRequiredError();
  try {
    await assertAuthority();
    for (const name of PRIVATE_STORE_CLAIM_PAYLOAD_NAMES) {
      await assertAuthority();
      await store.writeClaimPayload(claim, name, prepared.payloads[name]);
      await assertAuthority();
    }
    await assertAuthority();
    await store.writeClaimManifest(claim, prepared.rawManifest, null);
    await assertAuthority();
  } catch (error) {
    await quarantinePath(store, appHome, path).catch(() => undefined);
    throw error;
  }
  return {
    store,
    path,
    claim,
    manifest: prepared.manifest,
    rawManifest: prepared.rawManifest,
    payloads: prepared.payloads,
  };
}

async function scanJournals(appHome: string): Promise<JournalHandle[]> {
  const root = join(appHome, MODEL_PREFERENCE_DIRECTORY);
  const store = new PrivateStore({ root: appHome });
  await store.ensureDirectory(root);
  const entries = await readdir(root, { withFileTypes: true });
  const journals: JournalHandle[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ModelPreferenceRecoveryRequiredError();
    }
    if (!CANONICAL_UUID.test(entry.name)) {
      try {
        await quarantinePath(store, appHome, path);
      } catch {
        throw new ModelPreferenceRecoveryRequiredError();
      }
      continue;
    }
    try {
      const adopted = await store.adoptDirectoryClaim(path);
      const rawManifest = await store.readClaimManifest(adopted.claim, MANIFEST_LIMIT);
      const manifest = parseManifest(rawManifest, entry.name, appHome);
      const payloads = {} as Record<PrivateStoreClaimPayloadName, string>;
      for (const name of PRIVATE_STORE_CLAIM_PAYLOAD_NAMES) {
        payloads[name] = await store.readClaimPayload(
          adopted.claim,
          name,
          PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES,
        );
      }
      verifyPayloads(manifest, payloads);
      const handle: JournalHandle = {
        store,
        path,
        claim: adopted.claim,
        manifest,
        rawManifest,
        payloads: Object.freeze(payloads),
      };
      preparedFromJournal(handle);
      journals.push(handle);
    } catch {
      try {
        await quarantinePath(store, appHome, path);
      } catch {
        throw new ModelPreferenceRecoveryRequiredError();
      }
    }
  }
  return journals;
}

async function quarantinePath(
  store: PrivateStore,
  appHome: string,
  path: string,
): Promise<void> {
  const quarantineRoot = join(appHome, MODEL_PREFERENCE_QUARANTINE_DIRECTORY);
  await store.ensureDirectory(quarantineRoot);
  const destination = join(quarantineRoot, `${basename(resolve(path))}.${randomUUID()}`);
  await store.renameTree(path, destination, join(appHome, MODEL_PREFERENCE_DIRECTORY));
}

async function advanceJournal(
  journal: JournalHandle,
  expected: ModelPreferencePhase,
  next: ModelPreferencePhase,
  assertAuthority: () => void | Promise<void> = () => undefined,
): Promise<JournalHandle> {
  if (journal.manifest.phase !== expected) throw new ModelPreferenceRecoveryRequiredError();
  const manifest: ModelPreferenceTransactionV1 = { ...journal.manifest, phase: next };
  const rawManifest = serializeManifest(manifest);
  await assertAuthority();
  await journal.store.writeClaimManifest(journal.claim, rawManifest, journal.rawManifest);
  await assertAuthority();
  journal.manifest = manifest;
  journal.rawManifest = rawManifest;
  return journal;
}

async function removeJournal(
  journal: JournalHandle,
  assertAuthority: () => void | Promise<void> = () => undefined,
): Promise<void> {
  await assertAuthority();
  await journal.store.removeClaimManifest(journal.claim, journal.rawManifest);
  await assertAuthority();
  for (const name of PRIVATE_STORE_CLAIM_PAYLOAD_NAMES) {
    await assertAuthority();
    await journal.store.removeClaimPayload(journal.claim, name, journal.payloads[name]);
    await assertAuthority();
  }
  await assertAuthority();
  await journal.store.releaseDirectoryClaim(journal.claim, null);
  await assertAuthority();
}

async function convergeJournal(
  journal: JournalHandle,
  prepared: PreparedTransaction,
  target: "before" | "after",
  assertAuthority: () => void | Promise<void> = () => undefined,
): Promise<void> {
  const configRaws = [
    prepared.payloads["before-config.json"],
    prepared.stagingConfigRaw,
    prepared.payloads["after-config.json"],
  ] as const;
  const sessionRaws = [
    prepared.payloads["before-session.json"],
    prepared.payloads["after-session.json"],
  ] as const;
  await assertAuthority();
  await withPreferenceLocks(
    journal.manifest.configPath,
    journal.manifest.sessionPath,
    async (configOwnership, sessionOwnership) => {
      await assertAuthority();
      await assertAllowedRaw(configOwnership, configRaws);
      await assertAuthority();
      await assertAllowedRaw(sessionOwnership, sessionRaws);
      await assertAuthority();
      await publishExactRaw(
        configOwnership,
        configRaws,
        target === "before" ? configRaws[0] : configRaws[2],
        assertAuthority,
      );
      await assertAuthority();
      await publishExactRaw(
        sessionOwnership,
        sessionRaws,
        target === "before" ? sessionRaws[0] : sessionRaws[1],
        assertAuthority,
      );
      await assertAuthority();
    },
  );
  await assertAuthority();
}

type JournalFileDisposition = "recoverable-old" | "final" | "unknown";

/**
 * Classifies both durable owners before an abort reconciler changes either of
 * them. FINAL is accepted only as the complete exact file tuple; every natural
 * pre-provider publication prefix can be rolled back to OLD. Any third bytes,
 * or FINAL config paired with OLD session, retain the journal fail-closed.
 */
async function classifyJournalFiles(
  journal: JournalHandle,
  prepared: PreparedTransaction,
  assertAuthority: () => void | Promise<void> = () => undefined,
): Promise<JournalFileDisposition> {
  const beforeConfigRaw = prepared.payloads["before-config.json"];
  const beforeSessionRaw = prepared.payloads["before-session.json"];
  const finalConfigRaw = prepared.payloads["after-config.json"];
  const finalSessionRaw = prepared.payloads["after-session.json"];
  await assertAuthority();
  const disposition = await withPreferenceLocks(
    journal.manifest.configPath,
    journal.manifest.sessionPath,
    async (configOwnership, sessionOwnership) => {
      await assertAuthority();
      await configOwnership.assertHeld();
      await assertAuthority();
      const config = await readConfigFileSnapshot(configOwnership.canonicalPath);
      await assertAuthority();
      await sessionOwnership.assertHeld();
      await assertAuthority();
      const session = await readConfigFileSnapshot(sessionOwnership.canonicalPath);
      await assertAuthority();
      await configOwnership.assertHeld();
      await assertAuthority();
      await sessionOwnership.assertHeld();
      await assertAuthority();

      if (matchesRaw(config, finalConfigRaw) && matchesRaw(session, finalSessionRaw)) {
        return "final";
      }
      const configIsRecoverable = matchesRaw(config, beforeConfigRaw)
        || matchesRaw(config, prepared.stagingConfigRaw);
      const sessionIsRecoverable = matchesRaw(session, beforeSessionRaw)
        || matchesRaw(session, finalSessionRaw);
      return configIsRecoverable && sessionIsRecoverable
        ? "recoverable-old"
        : "unknown";
    },
  );
  await assertAuthority();
  return disposition;
}

async function classifyExactJournalFiles(
  journal: JournalHandle,
  prepared: PreparedTransaction,
  assertAuthority: () => void | Promise<void>,
): Promise<"before" | "after" | "unknown"> {
  await assertAuthority();
  const disposition = await withPreferenceLocks(
    journal.manifest.configPath,
    journal.manifest.sessionPath,
    async (configOwnership, sessionOwnership) => {
      await assertAuthority();
      const config = await readConfigFileSnapshot(configOwnership.canonicalPath);
      await assertAuthority();
      const session = await readConfigFileSnapshot(sessionOwnership.canonicalPath);
      await assertAuthority();
      if (matchesRaw(config, prepared.payloads["before-config.json"])
        && matchesRaw(session, prepared.payloads["before-session.json"])) return "before";
      if (matchesRaw(config, prepared.payloads["after-config.json"])
        && matchesRaw(session, prepared.payloads["after-session.json"])) return "after";
      return "unknown";
    },
  );
  await assertAuthority();
  return disposition;
}

async function assertAllowedRaw(
  ownership: ConfigWriteOwnership,
  allowed: readonly string[],
): Promise<void> {
  await ownership.assertHeld();
  const current = await readConfigFileSnapshot(ownership.canonicalPath);
  await ownership.assertHeld();
  if (!allowed.some((raw) => matchesRaw(current, raw))) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
}

async function withPreferenceLocks<T>(
  configPath: string,
  sessionPath: string,
  task: (
    configOwnership: ConfigWriteOwnership,
    sessionOwnership: ConfigWriteOwnership,
  ) => Promise<T>,
): Promise<T> {
  const configTarget = resolve(configPath);
  const sessionTarget = resolve(sessionPath);
  return withConfigWriteLocks([configTarget, sessionTarget], async (ownerships) => {
    const configOwnership = ownerships.find((entry) => entry.canonicalPath === configTarget);
    const sessionOwnership = ownerships.find((entry) => entry.canonicalPath === sessionTarget);
    if (!configOwnership || !sessionOwnership || configOwnership === sessionOwnership) {
      throw new ModelPreferenceRecoveryRequiredError();
    }
    return task(configOwnership, sessionOwnership);
  });
}

async function assertInitialSnapshots(
  input: RunModelPreferenceTransactionInput,
  configOwnership: ConfigWriteOwnership,
  sessionOwnership: ConfigWriteOwnership,
): Promise<void> {
  await configOwnership.assertHeld();
  const config = await readConfigFileSnapshot(configOwnership.canonicalPath);
  await sessionOwnership.assertHeld();
  const session = await readConfigFileSnapshot(sessionOwnership.canonicalPath);
  if (!sameConfigFileSnapshot(config, input.expectedConfig.file)
    || !sameConfigFileSnapshot(session, input.expectedSession.file)) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
}

async function assertRaw(
  ownership: ConfigWriteOwnership,
  raw: string,
): Promise<ConfigFileSnapshot & { readonly kind: "file" }> {
  await ownership.assertHeld();
  const current = await readConfigFileSnapshot(ownership.canonicalPath);
  await ownership.assertHeld();
  if (!matchesRaw(current, raw)) throw new ModelPreferenceRecoveryRequiredError();
  return current as ConfigFileSnapshot & { readonly kind: "file" };
}

async function publishExactRaw(
  ownership: ConfigWriteOwnership,
  allowed: readonly string[],
  target: string,
  assertAuthority: () => void | Promise<void> = () => undefined,
): Promise<void> {
  await assertAuthority();
  await ownership.assertHeld();
  await assertAuthority();
  const current = await readConfigFileSnapshot(ownership.canonicalPath);
  await assertAuthority();
  await ownership.assertHeld();
  await assertAuthority();
  if (!allowed.some((raw) => matchesRaw(current, raw))) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  if (matchesRaw(current, target)) return;
  try {
    await assertAuthority();
    await writeFileAtomicSecure(ownership.canonicalPath, target, async () => {
      await assertAuthority();
      await ownership.assertHeld();
      await assertAuthority();
      const fenced = await readConfigFileSnapshot(ownership.canonicalPath);
      await assertAuthority();
      if (!sameConfigFileSnapshot(fenced, current)) {
        throw new ModelPreferenceRecoveryRequiredError();
      }
      await ownership.assertHeld();
      await assertAuthority();
    });
    await assertAuthority();
  } catch (error) {
    if (!isAtomicFilePostPublicationError(error)) throw error;
  }
  await assertAuthority();
  await assertRaw(ownership, target);
  await assertAuthority();
}

async function readAuthority(
  authority: Pick<ModelPreferenceRouteAuthority, "read">,
  manifest: ModelPreferenceTransactionV1,
): Promise<"before" | "after"> {
  const snapshot = await authority.read();
  if (sameAuthority(snapshot, manifest.before.authority)) return "before";
  if (sameAuthority(snapshot, manifest.after.authority)) return "after";
  throw new ModelPreferenceRecoveryRequiredError();
}

async function readRecoveryAuthority(
  authority: RecoverModelPreferenceTransactionsInput["routeAuthority"],
  manifest: ModelPreferenceTransactionV1,
): Promise<"before" | "after"> {
  await authority.assertHeld();
  const result = await readAuthority(authority, manifest);
  await authority.assertHeld();
  return result;
}

function sameAuthority(
  left: ModelPreferenceAuthoritySnapshot,
  right: ModelPreferenceAuthorityIdentity,
): boolean {
  return left.providerRevision === right.providerRevision
    && left.connectionId === right.connectionId
    && sameExactModelPreferenceRoute(left.route, right.route);
}

function authorityFromConfig(
  config: OrcodeConfigWithBudget,
  route: RouteIdentityV1,
): ModelPreferenceAuthorityIdentity {
  const state = validateProviderSetupState(config.providerSetup);
  if (isProviderStateIssue(state)
    || config.mainModel !== route.requestedModelId
    || !sameExactModelPreferenceRoute(state.defaultRoute, route)
    || !Number.isSafeInteger(state.revision)
    || state.revision < 0) {
    throw new Error("Model preference route identity is invalid.");
  }
  const matches = state.connections.filter((connection) =>
    connection.enabled
    && connection.backendId === route.backendId
    && connection.accountFingerprint === route.accountFingerprint
    && connection.billingRealm === route.billingRealm
  );
  if (matches.length !== 1
    || !matches[0]!.id
    || matches[0]!.id.length > MAX_CONNECTION_ID_LENGTH
    || hasControl(matches[0]!.id)) {
    throw new Error("Model preference route identity is invalid.");
  }
  return {
    route: structuredClone(route),
    providerRevision: state.revision,
    connectionId: matches[0]!.id,
  };
}

function assertSessionTuple(data: PersistedSessionData, route: RouteIdentityV1): void {
  if (data.model !== route.requestedModelId
    || !sameExactModelPreferenceRoute(data.route, route)) {
    throw new Error("Model preference session tuple is invalid.");
  }
}

function exactResolvedRoute(value: RouteIdentityV1): RouteIdentityV1 {
  if (!isRecord(value as unknown)
    || !exactKeys(value as unknown as Record<string, unknown>, [
      "version",
      "backendId",
      "accountFingerprint",
      "billingRealm",
      "requestedModelId",
      "canonicalModelId",
      "resolutionState",
    ])) {
    throw new Error("Model preference route identity is invalid.");
  }
  const route = validateRouteIdentityV1(value);
  if (!route
    || route.resolutionState !== "resolved"
    || route.canonicalModelId === null
    || !sameExactModelPreferenceRoute(route, value)) {
    throw new Error("Model preference route identity is invalid.");
  }
  return route;
}

export function sameExactModelPreferenceRoute(
  left: RouteIdentityV1 | null | undefined,
  right: RouteIdentityV1 | null | undefined,
): boolean {
  return left !== null
    && left !== undefined
    && right !== null
    && right !== undefined
    && left.version === right.version
    && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.requestedModelId === right.requestedModelId
    && left.canonicalModelId === right.canonicalModelId
    && left.resolutionState === right.resolutionState;
}

function payloadDescriptor(
  name: PrivateStoreClaimPayloadName,
  content: string,
): ModelPreferencePayloadDescriptor {
  return { name, bytes: byteLength(content), sha256: digest(content) };
}

function verifyPayloads(
  manifest: ModelPreferenceTransactionV1,
  payloads: Readonly<Record<PrivateStoreClaimPayloadName, string>>,
): void {
  for (const descriptor of [
    manifest.before.config,
    manifest.before.session,
    manifest.after.config,
    manifest.after.session,
  ]) {
    const content = payloads[descriptor.name];
    if (byteLength(content) !== descriptor.bytes || digest(content) !== descriptor.sha256) {
      throw new ModelPreferenceRecoveryRequiredError();
    }
  }
}

function parseManifest(
  raw: string,
  expectedId: string,
  appHome = "",
): ModelPreferenceTransactionV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  if (!isRecord(value)
    || !exactKeys(value, [
      "version", "transactionId", "phase", "configPath", "sessionPath",
      "before", "after", "staging",
    ])
    || value.version !== 1
    || value.transactionId !== expectedId
    || !CANONICAL_UUID.test(expectedId)
    || !isPhase(value.phase)
    || !validPath(value.configPath)
    || !validPath(value.sessionPath)
    || value.configPath === value.sessionPath
    || (appHome !== "" && (
      !isContainedPath(appHome, value.configPath)
      || !isContainedPath(appHome, value.sessionPath)
    ))
    || !isTuple(value.before, "before")
    || !isTuple(value.after, "after")
    || !isStaging(value.staging)
    || (value.after as unknown as ModelPreferenceDurableTuple).authority.providerRevision
      !== (value.before as unknown as ModelPreferenceDurableTuple).authority.providerRevision + 1
    || sameExactModelPreferenceRoute(
      (value.before as unknown as ModelPreferenceDurableTuple).authority.route,
      (value.after as unknown as ModelPreferenceDurableTuple).authority.route,
    )) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  return value as unknown as ModelPreferenceTransactionV1;
}

function serializeManifest(value: ModelPreferenceTransactionV1): string {
  const raw = `${JSON.stringify(value)}\n`;
  if (byteLength(raw) > MANIFEST_LIMIT) throw new ModelPreferenceRecoveryRequiredError();
  return raw;
}

function isTuple(value: unknown, side: "before" | "after"): boolean {
  if (!isRecord(value)
    || !exactKeys(value, ["config", "session", "authority"])
    || !isPayload(value.config, `${side}-config.json`)
    || !isPayload(value.session, `${side}-session.json`)
    || !isAuthority(value.authority)) return false;
  return true;
}

function isPayload(value: unknown, name: string): boolean {
  return isRecord(value)
    && exactKeys(value, ["name", "bytes", "sha256"])
    && value.name === name
    && Number.isSafeInteger(value.bytes)
    && Number(value.bytes) >= 0
    && Number(value.bytes) <= PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES
    && typeof value.sha256 === "string"
    && SHA256.test(value.sha256);
}

function isAuthority(value: unknown): boolean {
  if (!isRecord(value)
    || !exactKeys(value, ["route", "providerRevision", "connectionId"])
    || !Number.isSafeInteger(value.providerRevision)
    || Number(value.providerRevision) < 0
    || typeof value.connectionId !== "string"
    || !value.connectionId
    || value.connectionId.length > MAX_CONNECTION_ID_LENGTH
    || hasControl(value.connectionId)) return false;
  try {
    exactResolvedRoute(value.route as RouteIdentityV1);
    return true;
  } catch {
    return false;
  }
}

function isStaging(value: unknown): boolean {
  return isRecord(value)
    && exactKeys(value, ["configBytes", "configSha256", "sessionBytes", "sessionSha256"])
    && validSize(value.configBytes)
    && validSize(value.sessionBytes)
    && typeof value.configSha256 === "string"
    && SHA256.test(value.configSha256)
    && typeof value.sessionSha256 === "string"
    && SHA256.test(value.sessionSha256);
}

function validSize(value: unknown): boolean {
  return Number.isSafeInteger(value)
    && Number(value) >= 0
    && Number(value) <= PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES;
}

function validPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PATH_LENGTH
    && isAbsolute(value)
    && resolve(value) === value
    && !hasControl(value);
}

function parseConfigPayload(raw: string): OrcodeConfigWithBudget {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  if (!isRecord(value) || !("providerSetup" in value)) {
    throw new ModelPreferenceRecoveryRequiredError();
  }
  const provider = validateProviderSetupState(value.providerSetup);
  if (isProviderStateIssue(provider)) throw new ModelPreferenceRecoveryRequiredError();
  return validateConfig(value as unknown as ConfigInput);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return isDeepStrictEqual(actual, expected);
}

function isPhase(value: unknown): value is ModelPreferencePhase {
  return value === "prepared"
    || value === "preferences-durable"
    || value === "route-durable"
    || value === "committed";
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Mirrors the provider coordinator's byte-preserving top-level CAS. FINAL is
 * exactly STAGING prefix/suffix plus the compact authoritative provider state. */
function replaceTopLevelJsonValue(
  raw: string,
  wantedKey: string,
  replacement: string,
): string {
  const span = findTopLevelJsonValue(raw, wantedKey);
  if (!span) throw new ModelPreferenceRecoveryRequiredError();
  return `${raw.slice(0, span.start)}${replacement}${raw.slice(span.end)}`;
}

function findTopLevelJsonValue(
  raw: string,
  wantedKey: string,
): { start: number; end: number } | null {
  let index = skipJsonWhitespace(raw, 0);
  if (raw[index] !== "{") return null;
  index = skipJsonWhitespace(raw, index + 1);
  let found: { start: number; end: number } | null = null;
  while (index < raw.length && raw[index] !== "}") {
    const keyEnd = scanJsonString(raw, index);
    if (keyEnd === null) return null;
    let key: unknown;
    try {
      key = JSON.parse(raw.slice(index, keyEnd));
    } catch {
      return null;
    }
    index = skipJsonWhitespace(raw, keyEnd);
    if (raw[index] !== ":") return null;
    const start = skipJsonWhitespace(raw, index + 1);
    const end = scanJsonValue(raw, start);
    if (end === null) return null;
    if (key === wantedKey) {
      if (found) return null;
      found = { start, end };
    }
    index = skipJsonWhitespace(raw, end);
    if (raw[index] === ",") index = skipJsonWhitespace(raw, index + 1);
    else if (raw[index] !== "}") return null;
  }
  return found;
}

function skipJsonWhitespace(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && /\s/u.test(raw[index]!)) index += 1;
  return index;
}

function scanJsonString(raw: string, start: number): number | null {
  if (raw[start] !== '"') return null;
  for (let index = start + 1; index < raw.length; index += 1) {
    if (raw[index] === "\\") index += 1;
    else if (raw[index] === '"') return index + 1;
  }
  return null;
}

function scanJsonValue(raw: string, start: number): number | null {
  if (raw[start] === '"') return scanJsonString(raw, start);
  if (raw[start] === "{" || raw[start] === "[") {
    const stack = [raw[start] === "{" ? "}" : "]"];
    for (let index = start + 1; index < raw.length; index += 1) {
      if (raw[index] === '"') {
        const end = scanJsonString(raw, index);
        if (end === null) return null;
        index = end - 1;
      } else if (raw[index] === "{") stack.push("}");
      else if (raw[index] === "[") stack.push("]");
      else if (raw[index] === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) return index + 1;
      }
    }
    return null;
  }
  let index = start;
  while (index < raw.length && !/[\s,}\]]/u.test(raw[index]!)) index += 1;
  return index > start ? index : null;
}

function matchesRaw(snapshot: ConfigFileSnapshot, raw: string): boolean {
  return snapshot.kind === "file"
    && snapshot.raw === raw
    && snapshot.digest === digest(raw);
}

function assertPayloadSize(content: string): void {
  if (byteLength(content) > PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES) {
    throw new ModelPreferencePayloadTooLargeError();
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel.length > 0
    && rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel);
}

function hit(
  input: Pick<RunModelPreferenceTransactionInput, "failpoint">,
  point: ModelPreferenceFailpoint,
): void {
  if (input.failpoint === point) throw new ModelPreferenceCrashError(point);
}
