import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

import type { RouteIdentityV1 } from "./backends.js";
import type { CrossProviderStage } from "./collaboration.js";
import type { NativeLocalActionRequirement } from "./desktop-contracts.js";
import {
  canonicalKimiNativeActionRequest,
  createKimiRequestId,
  type KimiNativeActionRequest,
  type KimiNativeActionRevocation,
  type NativeSidecarChannel,
} from "./native-sidecar-channel.js";
import {
  digestFinalKimiProviderRequest,
  type FinalKimiProviderRequestV1,
  type KimiProviderRequestDigest,
} from "./kimi-provider-request-digest.js";

export type KimiSetupPermitBinding = Omit<
  Extract<KimiNativeActionRequest, { kind: "kimi-setup" }>,
  "kind"
>;
export type KimiTurnPermitBinding = Omit<
  Extract<KimiNativeActionRequest, { kind: "kimi-turn" }>,
  "kind"
>;
export type KimiCrossPermitBinding = Omit<
  Extract<KimiNativeActionRequest, { kind: "kimi-cross" }>,
  "kind"
>;

export type KimiCrossStage = CrossProviderStage;

export interface KimiCrossStageBinding {
  readonly crossRunId: string;
  readonly stage: KimiCrossStage;
  readonly route: RouteIdentityV1;
  readonly signal?: AbortSignal;
}

export interface KimiCrossRequestBinding {
  readonly requestId: string;
  readonly crossRunId: string;
  readonly stage: KimiCrossStage;
  readonly route: RouteIdentityV1;
  readonly request: FinalKimiProviderRequestV1;
  readonly requestDigest: KimiProviderRequestDigest;
}

export interface KimiCrossStageRequestAuthority {
  readonly signal: AbortSignal;
  assertCurrent(): void;
  consumeRequest<T>(
    binding: KimiCrossRequestBinding,
    effect: (request: FinalKimiProviderRequestV1) => Promise<T>,
  ): Promise<T>;
}

export type KimiCrossRevokeReason = "end" | "stop" | "cancel" | "error" | "eof" | "restart";

export interface KimiCrossRunAuthority {
  runStage<T>(
    binding: KimiCrossStageBinding,
    effect: (authority: KimiCrossStageRequestAuthority) => Promise<T>,
  ): Promise<T>;
  revoke(reason: KimiCrossRevokeReason): void;
}

export class KimiDesktopPermitRequiredError extends Error {
  readonly code = "kimi-desktop-permit-required" as const;

  constructor() {
    super("A current private desktop Kimi permit is required.");
    this.name = "KimiDesktopPermitRequiredError";
  }
}

interface KimiPackagedRuntimeAttestation {
  readonly challenge: string;
  readonly sessionId: string;
  readonly childPid: number;
  readonly generation: number;
  readonly actionChannelId: "fd:198";
  readonly controlChannelId: "fd:199";
  readonly executablePath: string;
  readonly executableDevice: number;
  readonly executableInode: number;
  readonly executableSize: number;
  readonly policySha256: string;
  readonly executableSha256: string;
}

const CURRENT_PACKAGED_ATTESTATIONS = new WeakSet<object>();
const PACKAGED_ATTESTATION_BINDINGS = new WeakMap<object, Readonly<{
  permitReader: KimiDesktopPermitReader;
  childPid: number;
  generation: number;
}>>();
export function hasCurrentKimiPackagedRuntimeAttestation(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !CURRENT_PACKAGED_ATTESTATIONS.has(value)) return false;
  const binding = PACKAGED_ATTESTATION_BINDINGS.get(value);
  return binding !== undefined && binding.permitReader.isOpen;
}
export function matchesCurrentKimiPackagedRuntimeAttestation(
  value: unknown,
  permitReader: KimiDesktopPermitReader,
  childPid: number,
  generation: number,
): boolean {
  if (!hasCurrentKimiPackagedRuntimeAttestation(value)) return false;
  const binding = PACKAGED_ATTESTATION_BINDINGS.get(value as object);
  return binding?.permitReader === permitReader
    && binding.childPid === childPid
    && binding.generation === generation
    && permitReader.isOpen;
}

export function consumeCurrentKimiPackagedRuntimeAttestation(value: unknown): void {
  if (typeof value !== "object" || value === null || !hasCurrentKimiPackagedRuntimeAttestation(value)) {
    throw new KimiDesktopPermitRequiredError();
  }
  CURRENT_PACKAGED_ATTESTATIONS.delete(value);
  PACKAGED_ATTESTATION_BINDINGS.delete(value);
}

interface PendingPermit {
  readonly request: KimiNativeActionRequest;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly makeValue: () => unknown;
  readonly ready: Promise<void>;
  readonly markReady: () => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface KimiActionTombstone {
  readonly fence: KimiNativeActionRevocation;
  readonly requestDigest: string;
}

interface KimiActionFence {
  readonly requestId: string;
  readonly sessionId: string;
  readonly childPid: number;
  readonly revision: number;
  readonly generation: number;
  readonly deadlineAt: number;
}

const KIMI_NATIVE_ACTION_HISTORY_CAP = 1_024;

export interface KimiNativeActionIssueOptions {
  readonly signal?: AbortSignal;
  readonly onActionWritten: (requirement: NativeLocalActionRequirement) => void | Promise<void>;
}

type StageState = "unused" | "running" | "settled";

const STAGES = [
  "lead-analysis",
  "challenger-analysis",
  "lead-implementation",
  "challenger-review",
  "lead-repair",
  "challenger-repair-review",
] as const satisfies readonly CrossProviderStage[];

function stageRoute(stage: CrossProviderStage, lead: RouteIdentityV1, challenger: RouteIdentityV1): RouteIdentityV1 {
  switch (stage) {
    case "lead-analysis":
    case "lead-implementation":
    case "lead-repair":
      return lead;
    case "challenger-analysis":
    case "challenger-review":
    case "challenger-repair-review":
      return challenger;
  }
}

function applicablePredecessors(
  stage: CrossProviderStage,
  states: ReadonlyMap<CrossProviderStage, StageState>,
): readonly CrossProviderStage[] {
  if (stage === "lead-analysis" || stage === "challenger-analysis") return [];
  const index = STAGES.indexOf(stage);
  return STAGES.slice(0, index).filter((candidate) => states.has(candidate));
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

function sameRequest(left: KimiNativeActionRequest, right: KimiNativeActionRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actionDigest(request: KimiNativeActionRequest): string {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function sameFence(
  request: KimiActionFence,
  control: KimiActionFence,
): boolean {
  return control.requestId === request.requestId
    && control.sessionId === request.sessionId
    && control.childPid === request.childPid
    && control.revision === request.revision
    && control.generation === request.generation
    && control.deadlineAt === request.deadlineAt;
}

function revocationFor(request: KimiNativeActionRequest): KimiNativeActionRevocation {
  return Object.freeze({
    kind: "revoke",
    requestId: request.requestId,
    sessionId: request.sessionId,
    childPid: request.childPid,
    revision: request.revision,
    generation: request.generation,
    deadlineAt: request.deadlineAt,
  });
}

function publicRequirementFor(request: KimiNativeActionRequest): NativeLocalActionRequirement {
  const purposeCode = request.kind === "kimi-setup"
    ? "connect-membership"
    : request.kind === "kimi-turn"
      ? "send-turn"
      : "start-cross";
  return {
    kind: request.kind,
    revision: request.revision,
    generation: request.generation,
    purposeCode,
  };
}

function digestMatches(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

class BoundKimiCrossRunAuthority implements KimiCrossRunAuthority {
  #binding: Extract<KimiNativeActionRequest, { kind: "kimi-cross" }> | null;
  #dispose: (() => void) | null;
  readonly #states = new Map<CrossProviderStage, StageState>();
  readonly #requestIds = new Set<string>();
  readonly #rootController = new AbortController();
  #revoked = false;

  constructor(
    binding: Extract<KimiNativeActionRequest, { kind: "kimi-cross" }>,
    dispose: () => void,
  ) {
    this.#binding = binding;
    this.#dispose = dispose;
    for (const stage of STAGES) {
      if (binding.repairBudget === 0 && (stage === "lead-repair" || stage === "challenger-repair-review")) continue;
      if (stageRoute(stage, binding.lead, binding.challenger).backendId === "kimi-code") {
        this.#states.set(stage, "unused");
      }
    }
  }

  async runStage<T>(
    binding: KimiCrossStageBinding,
    effect: (authority: KimiCrossStageRequestAuthority) => Promise<T>,
  ): Promise<T> {
    const rootBinding = this.#binding;
    if (this.#revoked || rootBinding === null || typeof effect !== "function") return this.#reject();
    if (!binding || typeof binding !== "object"
      || binding.crossRunId !== rootBinding.crossRunId
      || !STAGES.includes(binding.stage)
      || !this.#states.has(binding.stage)) return this.#reject();
    const expectedRoute = stageRoute(binding.stage, rootBinding.lead, rootBinding.challenger);
    if (!exactRoute(binding.route, expectedRoute)
      || binding.route.backendId !== "kimi-code"
      || binding.route.resolutionState !== "resolved"
      || binding.route.billingRealm !== "kimi-code-membership-provider-managed-overage"
      || binding.signal?.aborted === true) return this.#reject();
    if (this.#states.get(binding.stage) !== "unused") return this.#reject();
    for (const predecessor of applicablePredecessors(binding.stage, this.#states)) {
      const state = this.#states.get(predecessor);
      if (state !== undefined && state !== "settled") return this.#reject();
    }

    const controller = new AbortController();
    const signal = binding.signal === undefined
      ? AbortSignal.any([this.#rootController.signal, controller.signal])
      : AbortSignal.any([this.#rootController.signal, controller.signal, binding.signal]);
    const onExternalAbort = (): void => this.revoke("cancel");
    binding.signal?.addEventListener("abort", onExternalAbort, { once: true });
    let active = true;
    let requestCount = 0;
    let activeRequests = 0;
    const reject = (): never => this.#reject();
    const assertCurrent = (): void => {
      if (this.#revoked || !active || signal.aborted
        || this.#states.get(binding.stage) !== "running") {
        reject();
      }
    };
    const authority: KimiCrossStageRequestAuthority = Object.freeze({
      signal,
      assertCurrent,
      consumeRequest: async <T>(
        requestBinding: KimiCrossRequestBinding,
        requestEffect: (request: FinalKimiProviderRequestV1) => Promise<T>,
      ): Promise<T> => {
        assertCurrent();
        if (typeof requestEffect !== "function"
          || !requestBinding || typeof requestBinding !== "object"
          || !/^[A-Za-z0-9_-]{32}$/.test(requestBinding.requestId)
          || this.#requestIds.has(requestBinding.requestId)
          || requestCount >= rootBinding.requestBudgetPerStage
          || requestBinding.crossRunId !== binding.crossRunId
          || requestBinding.stage !== binding.stage
          || !exactRoute(requestBinding.route, expectedRoute)
          || requestBinding.route.canonicalModelId !== requestBinding.request.model) reject();

        let immutableRequest: FinalKimiProviderRequestV1;
        try {
          immutableRequest = deepFreeze(structuredClone(requestBinding.request));
        } catch {
          return reject();
        }
        const recomputed = digestFinalKimiProviderRequest(immutableRequest);
        if (!digestMatches(recomputed, requestBinding.requestDigest)) return reject();
        this.#requestIds.add(requestBinding.requestId);
        requestCount += 1;
        activeRequests += 1;
        try {
          assertCurrent();
          const finalDigest = digestFinalKimiProviderRequest(immutableRequest);
          if (!digestMatches(finalDigest, requestBinding.requestDigest)) return reject();
          const value = await requestEffect(immutableRequest);
          assertCurrent();
          return value;
        } catch (error) {
          this.revoke("error");
          throw error;
        } finally {
          activeRequests -= 1;
        }
      },
    });

    this.#states.set(binding.stage, "running");
    try {
      const value = await effect(authority);
      assertCurrent();
      if (requestCount === 0 || activeRequests !== 0) return reject();
      this.#states.set(binding.stage, "settled");
      return value;
    } catch (error) {
      this.revoke("error");
      throw error;
    } finally {
      active = false;
      binding.signal?.removeEventListener("abort", onExternalAbort);
      controller.abort(new KimiDesktopPermitRequiredError());
    }
  }

  revoke(_reason: KimiCrossRevokeReason): void {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#binding = null;
    this.#rootController.abort(new KimiDesktopPermitRequiredError());
    this.#states.clear();
    this.#requestIds.clear();
    const dispose = this.#dispose;
    this.#dispose = null;
    dispose?.();
  }

  #reject(): never {
    this.revoke("error");
    throw new KimiDesktopPermitRequiredError();
  }
}

export class KimiDesktopPermitReader {
  readonly #pending = new Map<string, PendingPermit>();
  readonly #tombstones = new Map<string, KimiActionTombstone>();
  readonly #seenRequestIds = new Set<string>();
  readonly #authorities = new Set<BoundKimiCrossRunAuthority>();
  #closed = false;
  #pump: Promise<void> | null = null;
  readonly #startupChallenges = new Set<string>();
  readonly #startupAttestations = new Set<object>();
  #startupAttempted = false;

  constructor(
    private readonly channel: NativeSidecarChannel,
    private readonly now: () => number = Date.now,
  ) {
    if (!channel || !channel.isOpen) throw new KimiDesktopPermitRequiredError();
  }

  get isOpen(): boolean {
    return !this.#closed && this.channel.isOpen;
  }

  consumeSetup(binding: KimiSetupPermitBinding): Promise<void> {
    return this.issueSetup(binding, { onActionWritten() {} });
  }

  consumeTurn(binding: KimiTurnPermitBinding): Promise<void> {
    return this.issueTurn(binding, { onActionWritten() {} });
  }

  consumeCrossClaim(binding: KimiCrossPermitBinding): Promise<KimiCrossRunAuthority> {
    return this.issueCrossClaim(binding, { onActionWritten() {} });
  }

  readActiveCrossAuthorityCountForTest(): number {
    return this.#authorities.size;
  }

  async consumePackagedStartup(timeoutMs = 250): Promise<KimiPackagedRuntimeAttestation> {
    if (!this.isOpen || this.#startupAttempted) throw new KimiDesktopPermitRequiredError();
    this.#startupAttempted = true;
    const request = Object.freeze({ kind: "packaged-startup" as const, requestId: createKimiRequestId(), challenge: randomBytes(16).toString("base64url"), sessionId: randomBytes(16).toString("base64url"), childPid: process.pid, actionChannelId: "fd:198" as const, controlChannelId: "fd:199" as const });
    this.#startupChallenges.add(request.challenge);
    let handle;
    try {
      const deadlineAt = this.now() + Math.max(1, Math.min(timeoutMs, 2_147_483_647));
      const write = this.channel.writePackagedStartup(request);
      void write.catch(() => undefined);
      await this.#awaitBoundary(write, deadlineAt);
      const raw = await this.#awaitBoundary(this.channel.readKimiControl(), deadlineAt);
      if (!raw || raw.kind !== "packaged-attestation" || raw.requestId !== request.requestId || raw.challenge !== request.challenge || raw.sessionId !== request.sessionId || raw.childPid !== request.childPid || raw.actionChannelId !== request.actionChannelId || raw.controlChannelId !== request.controlChannelId) throw new KimiDesktopPermitRequiredError();
      handle = await open(raw.executablePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (info.dev !== raw.executableDevice || info.ino !== raw.executableInode || info.size !== raw.executableSize) throw new KimiDesktopPermitRequiredError();
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < info.size) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position); if (bytesRead === 0) throw new KimiDesktopPermitRequiredError(); hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
      if (!digestMatches(hash.digest("hex"), raw.executableSha256)) throw new KimiDesktopPermitRequiredError();
      const { requestId: _, kind: __, ...privateFields } = raw;
      const attestation = deepFreeze(privateFields) as KimiPackagedRuntimeAttestation;
      CURRENT_PACKAGED_ATTESTATIONS.add(attestation);
      PACKAGED_ATTESTATION_BINDINGS.set(attestation, Object.freeze({
        permitReader: this,
        childPid: raw.childPid,
        generation: raw.generation,
      }));
      this.#startupAttestations.add(attestation);
      return attestation;
    } catch { this.close("restart"); throw new KimiDesktopPermitRequiredError(); }
    finally { await handle?.close().catch(() => {}); }
  }

  issueSetup(binding: KimiSetupPermitBinding, options: KimiNativeActionIssueOptions): Promise<void> {
    return this.#issue({ kind: "kimi-setup", ...binding }, () => undefined, options);
  }

  issueTurn(binding: KimiTurnPermitBinding, options: KimiNativeActionIssueOptions): Promise<void> {
    return this.#issue({ kind: "kimi-turn", ...binding }, () => undefined, options);
  }

  issueCrossClaim(
    binding: KimiCrossPermitBinding,
    options: KimiNativeActionIssueOptions,
  ): Promise<KimiCrossRunAuthority> {
    let canonical!: Extract<KimiNativeActionRequest, { kind: "kimi-cross" }>;
    return this.#issue({ kind: "kimi-cross", ...binding }, () => {
      let authority!: BoundKimiCrossRunAuthority;
      authority = new BoundKimiCrossRunAuthority(canonical, () => {
        this.#authorities.delete(authority);
      });
      this.#authorities.add(authority);
      return authority;
    }, options, (request) => {
      canonical = request as Extract<KimiNativeActionRequest, { kind: "kimi-cross" }>;
    });
  }

  close(reason: KimiCrossRevokeReason = "eof"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.channel.close();
    for (const authority of this.#authorities) authority.revoke(reason);
    this.#authorities.clear();
    const error = new KimiDesktopPermitRequiredError();
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort!);
      pending.markReady();
      pending.reject(error);
    }
    this.#tombstones.clear();
    this.#seenRequestIds.clear();
    this.#startupChallenges.clear();
    for (const attestation of this.#startupAttestations) CURRENT_PACKAGED_ATTESTATIONS.delete(attestation);
    this.#startupAttestations.clear();
  }

  #issue<T>(
    rawRequest: KimiNativeActionRequest,
    makeValue: () => T,
    options: KimiNativeActionIssueOptions,
    observeCanonical?: (request: KimiNativeActionRequest) => void,
  ): Promise<T> {
    if (!this.isOpen
      || !options
      || typeof options.onActionWritten !== "function"
      || options.signal?.aborted) {
      return Promise.reject(new KimiDesktopPermitRequiredError());
    }
    let request: KimiNativeActionRequest;
    try {
      request = canonicalKimiNativeActionRequest(rawRequest);
    } catch {
      return Promise.reject(new KimiDesktopPermitRequiredError());
    }
    observeCanonical?.(request);
    if (this.#seenRequestIds.has(request.requestId)
      || this.#pending.has(request.requestId)
      || this.#tombstones.has(request.requestId)) {
      return Promise.reject(new KimiDesktopPermitRequiredError());
    }
    if (this.#seenRequestIds.size >= KIMI_NATIVE_ACTION_HISTORY_CAP) {
      this.close("restart");
      return Promise.reject(new KimiDesktopPermitRequiredError());
    }

    // Reserve the one-shot request before any write/read await can yield.
    this.#seenRequestIds.add(request.requestId);
    const remaining = request.deadlineAt - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return Promise.reject(new KimiDesktopPermitRequiredError());
    }

    const promise = new Promise<T>((resolve, reject) => {
      let markReady!: () => void;
      const ready = new Promise<void>((readyResolve) => { markReady = readyResolve; });
      const timer = setTimeout(() => {
        void this.#revokePending(request.requestId, new KimiDesktopPermitRequiredError());
      }, Math.min(remaining, 2_147_483_647));
      const pending: PendingPermit = {
        request,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        makeValue,
        ready,
        markReady,
        signal: options.signal,
      };
      if (options.signal) {
        const onAbort = () => {
          void this.#revokePending(request.requestId, new KimiDesktopPermitRequiredError());
        };
        Object.assign(pending, { onAbort });
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#pending.set(request.requestId, pending);
    });
    this.#ensurePump();
    if (options.signal?.aborted) {
      void this.#revokePending(request.requestId, new KimiDesktopPermitRequiredError());
    } else {
      void this.#writeAndProject(request, options);
    }
    return promise;
  }

  async #writeAndProject(
    request: KimiNativeActionRequest,
    options: KimiNativeActionIssueOptions,
  ): Promise<void> {
    try {
      const write = this.channel.writeKimiAction(request);
      void write.catch(() => undefined);
      await this.#awaitBoundary(write, request.deadlineAt, options.signal);
    } catch {
      this.close("error");
      return;
    }
    const pending = this.#pending.get(request.requestId);
    if (!pending || pending.request !== request) return;
    try {
      await options.onActionWritten(publicRequirementFor(request));
    } catch (error) {
      await this.#revokePending(request.requestId, error);
      return;
    }
    const current = this.#pending.get(request.requestId);
    if (current && current.request === request) current.markReady();
  }

  async #revokePending(requestId: string, error: unknown): Promise<void> {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    // The tombstone exists before the revoke write can yield. A matching late
    // result is harmless; every other unknown result still poisons the reader.
    this.#tombstones.set(requestId, {
      fence: revocationFor(pending.request),
      requestDigest: actionDigest(pending.request),
    });
    pending.markReady();
    const revocation = this.channel.writeKimiRevocation(revocationFor(pending.request));
    void revocation.catch(() => undefined);
    if (this.now() >= pending.request.deadlineAt) {
      pending.reject(error);
      this.close("error");
      return;
    }
    try {
      await this.#awaitBoundary(
        revocation,
        Math.max(this.now() + 1, Math.min(pending.request.deadlineAt, this.now() + 250)),
      );
    } catch {
      pending.reject(new KimiDesktopPermitRequiredError());
      this.close("error");
      return;
    }
    pending.reject(error);
  }

  async #awaitBoundary<T>(operation: Promise<T>, deadlineAt: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new KimiDesktopPermitRequiredError();
    const remaining = Math.max(1, Math.min(deadlineAt - this.now(), 2_147_483_647));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detach = () => {};
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new KimiDesktopPermitRequiredError()), remaining);
      });
      const aborted = new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        const onAbort = () => reject(new KimiDesktopPermitRequiredError());
        signal.addEventListener("abort", onAbort, { once: true });
        detach = () => signal.removeEventListener("abort", onAbort);
      });
      return await Promise.race([operation, timeout, aborted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      detach();
    }
  }

  #ensurePump(): void {
    if (this.#pump !== null || this.#closed) return;
    this.#pump = this.#runPump().finally(() => { this.#pump = null; });
  }

  async #runPump(): Promise<void> {
    try {
      while (!this.#closed) {
        const control = await this.channel.readKimiControl();
        if (control === null) {
          this.close("eof");
          return;
        }
        if (control.kind === "packaged-attestation") {
          this.close("restart");
          return;
        }
        const requestId = control.kind === "permit" ? control.request.requestId : control.requestId;
        let pending = this.#pending.get(requestId);
        if (pending) {
          await pending.ready;
          pending = this.#pending.get(requestId);
        }
        if (!pending) {
          const tombstone = this.#tombstones.get(requestId);
          const matchesTombstone = tombstone && (control.kind === "permit"
            ? sameFence(tombstone.fence, control.request)
              && digestMatches(tombstone.requestDigest, actionDigest(control.request))
            : sameFence(tombstone.fence, control));
          if (matchesTombstone) {
            this.#tombstones.delete(requestId);
            continue;
          }
          this.close("restart");
          return;
        }

        // Consume the private result and erase its pending request before resolution.
        this.#pending.delete(requestId);
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) {
          pending.signal.removeEventListener("abort", pending.onAbort);
        }
        if (this.now() >= pending.request.deadlineAt) {
          this.#pending.set(requestId, pending);
          await this.#revokePending(requestId, new KimiDesktopPermitRequiredError());
          return;
        }
        const matches = control.kind === "permit"
          ? sameRequest(pending.request, control.request)
          : sameFence(pending.request, control);
        if (!matches) {
          pending.reject(new KimiDesktopPermitRequiredError());
          this.close("restart");
          return;
        }
        if (control.kind === "denied") {
          pending.reject(new KimiDesktopPermitRequiredError());
          continue;
        }
        pending.resolve(pending.makeValue());
      }
    } catch {
      this.close("error");
    }
  }
}
