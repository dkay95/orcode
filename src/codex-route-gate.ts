import { createHash, randomBytes } from "node:crypto";
import { assertCodexAccountFingerprint } from "./codex-account-identity.js";
import { isAbsolute } from "node:path";

import type { RouteIdentityV1 } from "./backends.js";
import {
  CodexAppServerClient,
  type CodexAppServerRequestId,
  type CodexAppServerRequestListener,
  type CodexAppServerTerminalListener,
} from "./codex-app-server.js";

declare const codexRouteDispatchPermitBrand: unique symbol;
const permitBrand = Symbol("CodexRouteDispatchPermit");
declare const codexOperationAuthorityBrand: unique symbol;

export interface CodexOperationScope {
  readonly childGeneration: number;
  readonly threadId: string;
  readonly turnId: string;
  readonly stagingRealpath: string;
  readonly routeDigest: string;
}
export interface CodexOperationAuthority { readonly [codexOperationAuthorityBrand]: true }
interface OperationRecord {
  readonly client: CodexAppServerClient;
  readonly scope: Readonly<CodexOperationScope>;
  readonly isCurrent: () => boolean;
  claimed: boolean;
  drained: boolean;
}
const OPERATION_RECORDS = new WeakMap<object, OperationRecord>();

export interface CodexRouteBinding {
  readonly profileId: string;
  readonly codexHomeRealpath: string;
  readonly route: RouteIdentityV1;
  readonly modelId: string;
}

export interface CodexRouteDispatchPermit {
  readonly [codexRouteDispatchPermitBrand]: true;
  readonly permitId: string;
  readonly binding: Readonly<{
    profileId: string;
    codexHomeRealpath: string;
    route: RouteIdentityV1;
    modelId: string;
    accountType: "chatgpt";
    planType: string;
  }>;
  readonly epochs: Readonly<{
    childGeneration: number;
    profile: number;
    home: number;
    route: number;
    model: number;
    account: number;
    auth: number;
    plan: number;
  }>;
}

export interface CodexAccountUpdatedObservation {
  readonly childGeneration: number;
  readonly params: Readonly<{ authMode: unknown; planType: unknown }>;
}

interface AccountClient {
  onNotification(method: "account/updated", listener: (params: unknown) => void): () => void;
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
}

interface GateOptions extends CodexRouteBinding {
  readonly client: AccountClient;
  readonly childGeneration: number;
  readonly createPermitId?: () => string;
}

type Epochs = {
  childGeneration: number;
  profile: number;
  home: number;
  route: number;
  model: number;
  account: number;
  auth: number;
  plan: number;
};

type AccountEvent = Readonly<{ authMode: unknown; planType: unknown }>;

export class CodexRouteGate {
  readonly #client: AccountClient;
  readonly #createPermitId: () => string;
  readonly #permits = new Set<object>();
  #detachAccountUpdated: () => void = () => {};
  #binding: CodexRouteBinding;
  #childGeneration: number;
  #event: AccountEvent | null = null;
  #modelCatalog: string | null = null;
  #rateLimits: string | null = null;
  #epochs: Epochs = {
    childGeneration: 0, profile: 0, home: 0, route: 0,
    model: 0, account: 0, auth: 0, plan: 0,
  };
  #taskBytesSent = 0;

  constructor(options: GateOptions) {
    if (!isPlainObject(options) || !exactOptionalKeys(options, [
      "client", "childGeneration", "profileId", "codexHomeRealpath", "route", "modelId",
    ], ["createPermitId"])) {
      throw new Error("Codex route binding is invalid.");
    }
    this.#client = options.client;
    this.#childGeneration = safeGeneration(options.childGeneration);
    this.#binding = canonicalBinding({
      profileId: options.profileId,
      codexHomeRealpath: options.codexHomeRealpath,
      route: options.route,
      modelId: options.modelId,
    });
    this.#createPermitId = options.createPermitId ?? (() => randomBytes(24).toString("base64url"));
    this.#attachAccountUpdated();
  }

  get taskBytesSent(): number {
    return this.#taskBytesSent;
  }

  observeAccountUpdated(observation: CodexAccountUpdatedObservation): void {
    if (safeGeneration(observation.childGeneration) !== this.#childGeneration) return;
    this.#epochs.auth += 1;
    this.#revoke();
    const params = observation.params;
    if (!isPlainObject(params) || !exactKeys(params, ["authMode", "planType"])) {
      this.#event = null;
      return;
    }
    if (this.#event?.planType !== params.planType) this.#epochs.plan += 1;
    this.#event = Object.freeze({ authMode: params.authMode, planType: params.planType });
  }

  setChildGeneration(generation: number): void {
    const next = safeGeneration(generation);
    if (next === this.#childGeneration) return;
    this.#detachAccountUpdated();
    this.#detachAccountUpdated = () => {};
    this.#childGeneration = next;
    this.#epochs.childGeneration += 1;
    this.#event = null;
    this.#revoke();
    this.#attachAccountUpdated();
  }

  isCurrentChildGeneration(generation: number): boolean {
    return Number.isSafeInteger(generation) && generation === this.#childGeneration;
  }

  updateBinding(binding: CodexRouteBinding): void {
    const next = canonicalBinding(binding);
    if (next.profileId !== this.#binding.profileId) this.#epochs.profile += 1;
    if (next.codexHomeRealpath !== this.#binding.codexHomeRealpath) this.#epochs.home += 1;
    if (!sameExactRoute(next.route, this.#binding.route)) this.#epochs.route += 1;
    if (next.modelId !== this.#binding.modelId) this.#epochs.model += 1;
    if (!sameBinding(next, this.#binding)) {
      this.#binding = next;
      this.#event = null;
      this.#revoke();
    }
  }

  observeModelCatalog(modelIds: readonly string[]): void {
    if (!Array.isArray(modelIds) || modelIds.some((modelId) => !safeText(modelId))
      || new Set(modelIds).size !== modelIds.length) {
      this.#modelCatalog = null;
      this.#epochs.model += 1;
      this.#revoke();
      return;
    }
    const next = JSON.stringify([...modelIds]);
    if (next === this.#modelCatalog) return;
    this.#modelCatalog = next;
    this.#epochs.model += 1;
    this.#revoke();
  }

  observeRateLimits(value: unknown): void {
    let next: string;
    try { next = JSON.stringify(value); } catch { next = "invalid"; }
    if (next === this.#rateLimits) return;
    this.#rateLimits = next;
    this.#epochs.account += 1;
    this.#revoke();
  }

  observeLogout(): void {
    this.#event = null;
    this.#epochs.account += 1;
    this.#epochs.auth += 1;
    this.#revoke();
  }

  async refreshAndIssueDispatchPermit(
    binding: CodexRouteBinding,
    signal?: AbortSignal,
  ): Promise<CodexRouteDispatchPermit> {
    const requested = canonicalBinding(binding);
    if (!sameBinding(requested, this.#binding)) throw new Error("Codex route binding is stale.");
    const event = this.#event;
    // The pinned server need not emit account/updated on startup. Only a
    // never-observed fresh child may establish auth from the real read below;
    // logout, malformed observations, and revocation can never re-enter it.
    if (event === null ? this.#epochs.auth !== 0
      : event.authMode !== "chatgpt" || !safePlan(event.planType)) {
      throw new Error("Codex authentication is not current.");
    }
    if (event === null && !/^codex-sha256:[0-9a-f]{64}$/.test(requested.route.accountFingerprint)) {
      throw new Error("Codex account identity requires verification. Reconnect the ChatGPT profile.");
    }
    const generation = this.#childGeneration;
    const authEpoch = this.#epochs.auth;
    const accountEpoch = ++this.#epochs.account;
    this.#revoke();
    const response = await this.#client.request<unknown>("account/read", { refreshToken: false }, signal);
    if (generation !== this.#childGeneration || authEpoch !== this.#epochs.auth
      || accountEpoch !== this.#epochs.account || event !== this.#event) {
      throw new Error("Stale account read rejected.");
    }
    const account = validateAccountRead(response, event?.planType);
    const billingRealm = account.planType === "free" || account.planType === "unknown"
      ? "chatgpt-account-provider-managed-limits" : "chatgpt-subscription-provider-managed-overage";
    if (requested.route.billingRealm !== billingRealm) throw new Error("Codex account billing plan changed.");
    assertCodexAccountFingerprint(requested.route.accountFingerprint, requested.profileId, response);
    const epochs = Object.freeze({ ...this.#epochs, childGeneration: this.#childGeneration });
    const publicBinding = Object.freeze({
      profileId: requested.profileId,
      codexHomeRealpath: requested.codexHomeRealpath,
      route: Object.freeze({ ...requested.route }),
      modelId: requested.modelId,
      accountType: "chatgpt" as const,
      planType: account.planType,
    });
    const permit = {
      permitId: this.#createPermitId(),
      binding: publicBinding,
      epochs,
    } as CodexRouteDispatchPermit & Record<PropertyKey, unknown>;
    Object.defineProperties(permit, {
      [permitBrand]: { value: true },
      toJSON: { value: () => { throw new TypeError("Codex route permit is not serializable."); } },
    });
    Object.freeze(permit);
    this.#permits.add(permit);
    return permit;
  }

  consumeDispatchPermit(permit: CodexRouteDispatchPermit, binding: CodexRouteBinding): boolean {
    if (!isPlainObject(permit) || (permit as Record<PropertyKey, unknown>)[permitBrand] !== true) return false;
    if (!this.#permits.delete(permit)) return false;
    let requested: CodexRouteBinding;
    try {
      requested = canonicalBinding(binding);
    } catch {
      return false;
    }
    return sameBinding(requested, this.#binding)
      && sameBinding(requested, permit.binding)
      && permit.binding.accountType === "chatgpt"
      && exactEpochs(permit.epochs, this.#epochs, this.#childGeneration);
  }

  async consumeAndWriteTurn<T extends Readonly<Record<string, unknown>>>(
    permit: CodexRouteDispatchPermit,
    client: CodexAppServerClient,
    binding: CodexRouteBinding,
    params: T,
    scope: Omit<CodexOperationScope, "turnId">,
    signal?: AbortSignal,
  ): Promise<Readonly<{ result: unknown; authority: CodexOperationAuthority }>> {
    if (!(client instanceof CodexAppServerClient) || client !== this.#client) {
      throw new Error("Codex turn client is not the exact route-gate client.");
    }
    if (!this.consumeDispatchPermit(permit, binding)) {
      throw new Error("Stale route dispatch permit rejected before turn/start bytes.");
    }
    if (scope.childGeneration !== permit.epochs.childGeneration
      || scope.threadId !== params.threadId || scope.stagingRealpath !== params.cwd
      || scope.routeDigest !== createHash("sha256").update(JSON.stringify(binding)).digest("hex")) {
      throw new Error("Codex operation scope does not match the consumed route and turn frame.");
    }
    const result = await client.requestGuarded<unknown>("turn/start", params, () => {
      if (!sameBinding(canonicalBinding(binding), this.#binding)
        || !exactEpochs(permit.epochs, this.#epochs, this.#childGeneration)) {
        throw new Error("Stale route dispatch permit rejected at physical turn/start write.");
      }
    }, signal);
    this.#taskBytesSent += Buffer.byteLength(JSON.stringify(params), "utf8");
    const turnId = extractTurnId(result);
    const operationBinding = canonicalBinding(binding);
    return Object.freeze({
      result,
      authority: createOperationAuthority(client, { ...scope, turnId }, () =>
        sameBinding(operationBinding, this.#binding)
        && exactEpochs(permit.epochs, this.#epochs, this.#childGeneration)),
    });
  }

  revoke(): void {
    this.#event = null;
    this.#epochs.auth += 1;
    this.#revoke();
  }

  #revoke(): void {
    this.#permits.clear();
  }

  #attachAccountUpdated(): void {
    // Every listener is bound to exactly one child generation. Replacing a
    // child first detaches this closure, so an old client callback can never
    // be relabelled with successor authority.
    const listenerGeneration = this.#childGeneration;
    this.#detachAccountUpdated = this.#client.onNotification("account/updated", (params) => {
      this.observeAccountUpdated({ childGeneration: listenerGeneration, params: params as never });
    });
  }
}

export interface ClaimedCodexOperation {
  readonly respond: (
    id: CodexAppServerRequestId,
    result: unknown,
    guard?: () => void,
  ) => Promise<void>;
  readonly onRequest: (listener: CodexAppServerRequestListener) => () => void;
  readonly onTerminal: (listener: CodexAppServerTerminalListener) => () => void;
  readonly interrupt: () => Promise<void>;
  readonly drain: () => Promise<"closed" | "killed">;
  readonly isCurrent: () => boolean;
}

export function claimCodexOperationAuthority(
  authority: CodexOperationAuthority,
  scope: CodexOperationScope,
): ClaimedCodexOperation {
  const record = OPERATION_RECORDS.get(authority as object);
  const canonical = canonicalOperationScope(scope);
  if (!record || record.claimed || record.drained || !sameOperationScope(record.scope, canonical)) {
    throw new Error("Codex operation authority is invalid, stale, mismatched, or already used.");
  }
  record.claimed = true;
  return Object.freeze({
    respond: (id: CodexAppServerRequestId, result: unknown, guard?: () => void) =>
      record.client.respondToServerRequest(id, result, () => {
        if (requiresCurrentApprovalAuthority(result)
          && (!record.isCurrent() || record.drained)) {
          throw new Error("Codex approval authority changed before the physical response write.");
        }
        guard?.();
      }),
    onRequest: (listener: CodexAppServerRequestListener) => record.client.onServerRequest(listener),
    onTerminal: (listener: CodexAppServerTerminalListener) => record.client.onTerminal(listener),
    isCurrent: () => record.isCurrent() && !record.drained,
    interrupt: async () => {
      await record.client.request("turn/interrupt", { threadId: record.scope.threadId, turnId: record.scope.turnId });
    },
    drain: async () => {
      if (record.drained) throw new Error("Codex operation drain authority was already used.");
      record.drained = true;
      return CodexAppServerClient.prototype.drain.call(record.client);
    },
  });
}

function createOperationAuthority(
  client: CodexAppServerClient,
  scope: CodexOperationScope,
  isCurrent: () => boolean,
): CodexOperationAuthority {
  const canonical = canonicalOperationScope(scope);
  const authority = Object.freeze({}) as CodexOperationAuthority;
  OPERATION_RECORDS.set(authority, {
    client, scope: canonical, isCurrent, claimed: false, drained: false,
  });
  return authority;
}

function canonicalOperationScope(scope: CodexOperationScope): Readonly<CodexOperationScope> {
  if (!scope || typeof scope !== "object" || !Number.isSafeInteger(scope.childGeneration)
    || scope.childGeneration < 0 || !safeText(scope.threadId) || !safeText(scope.turnId)
    || !isAbsolute(scope.stagingRealpath) || !/^[0-9a-f]{64}$/.test(scope.routeDigest)) {
    throw new Error("Codex operation scope is invalid.");
  }
  return Object.freeze({ ...scope });
}

function sameOperationScope(left: CodexOperationScope, right: CodexOperationScope): boolean {
  return left.childGeneration === right.childGeneration && left.threadId === right.threadId
    && left.turnId === right.turnId && left.stagingRealpath === right.stagingRealpath
    && left.routeDigest === right.routeDigest;
}

function extractTurnId(result: unknown): string {
  if (!isPlainObject(result) || !exactKeys(result, ["turn"]) || !isPlainObject(result.turn)
    || !exactKeys(result.turn, [
      "id", "items", "itemsView", "status", "error", "startedAt", "completedAt", "durationMs",
    ]) || !safeText(result.turn.id) || !Array.isArray(result.turn.items)
    || result.turn.items.length > 4_096
    || result.turn.items.some((item) => !isOfficialTurnItemEnvelope(item))
    || !["notLoaded", "summary", "full"].includes(result.turn.itemsView as string)
    || !["completed", "interrupted", "failed", "inProgress"].includes(result.turn.status as string)
    || !(result.turn.error === null || isOfficialTurnError(result.turn.error))
    || !nullableNonNegativeNumber(result.turn.startedAt)
    || !nullableNonNegativeNumber(result.turn.completedAt)
    || !nullableNonNegativeNumber(result.turn.durationMs)) {
    throw new Error("Codex turn/start response is invalid.");
  }
  return result.turn.id;
}

function isOfficialTurnItemEnvelope(value: unknown): boolean {
  return isPlainObject(value) && safeText(value.type) && safeText(value.id)
    && isBoundedPlainJson(value, 0, { remaining: 10_000 });
}

function isOfficialTurnError(value: unknown): boolean {
  return isPlainObject(value) && exactKeys(value, ["message", "codexErrorInfo", "additionalDetails"])
    && typeof value.message === "string" && value.message.length <= 128 * 1_024
    && (value.additionalDetails === null
      || typeof value.additionalDetails === "string" && value.additionalDetails.length <= 128 * 1_024)
    && (value.codexErrorInfo === null || isBoundedPlainJson(value.codexErrorInfo, 0, { remaining: 10_000 }));
}

function nullableNonNegativeNumber(value: unknown): boolean {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedPlainJson(value: unknown, depth: number, budget: { remaining: number }): boolean {
  if (budget.remaining-- <= 0 || depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 4_096
      && value.every((entry) => isBoundedPlainJson(entry, depth + 1, budget));
  }
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= 4_096 && keys.every((key) => typeof key === "string"
    && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
    && isBoundedPlainJson(value[key], depth + 1, budget));
}

function validateAccountRead(value: unknown, expectedPlan?: unknown): { planType: string } {
  if (!isPlainObject(value) || !exactKeys(value, ["account", "requiresOpenaiAuth"])
    || value.requiresOpenaiAuth !== true || !isPlainObject(value.account)
    || !exactKeys(value.account, ["type", "email", "planType"])
    || value.account.type !== "chatgpt" || !safePlan(value.account.planType)
    || (expectedPlan !== undefined && value.account.planType !== expectedPlan)
    || (value.account.email !== null && typeof value.account.email !== "string")) {
    throw new Error("Codex account authentication is not eligible.");
  }
  return { planType: value.account.planType };
}

function canonicalBinding(value: CodexRouteBinding): CodexRouteBinding {
  if (!isPlainObject(value) || !exactKeys(value, [
    "profileId", "codexHomeRealpath", "route", "modelId",
  ]) || !safeText(value.profileId) || !isAbsolute(value.codexHomeRealpath)
    || !safeText(value.modelId) || !isCodexRoute(value.route)
    || value.route.canonicalModelId !== value.modelId) {
    throw new Error("Codex route binding is invalid.");
  }
  return Object.freeze({
    profileId: value.profileId,
    codexHomeRealpath: value.codexHomeRealpath,
    route: Object.freeze({
      version: value.route.version,
      backendId: value.route.backendId,
      accountFingerprint: value.route.accountFingerprint,
      billingRealm: value.route.billingRealm,
      requestedModelId: value.route.requestedModelId,
      canonicalModelId: value.route.canonicalModelId,
      resolutionState: value.route.resolutionState,
    }),
    modelId: value.modelId,
  });
}

function isCodexRoute(route: unknown): route is RouteIdentityV1 {
  return isPlainObject(route) && exactKeys(route, [
    "version", "backendId", "accountFingerprint", "billingRealm",
    "requestedModelId", "canonicalModelId", "resolutionState",
  ]) && route.version === 1 && route.backendId === "codex"
    && route.resolutionState === "resolved" && route.canonicalModelId !== null
    && safeText(route.accountFingerprint) && safeText(route.requestedModelId)
    && (route.billingRealm === "chatgpt-subscription-provider-managed-overage"
      || route.billingRealm === "chatgpt-account-provider-managed-limits");
}

function sameBinding(left: CodexRouteBinding, right: CodexRouteBinding): boolean {
  return left.profileId === right.profileId
    && left.codexHomeRealpath === right.codexHomeRealpath
    && left.modelId === right.modelId
    && sameExactRoute(left.route, right.route);
}

function sameExactRoute(left: RouteIdentityV1, right: RouteIdentityV1): boolean {
  return left.version === right.version && left.backendId === right.backendId
    && left.accountFingerprint === right.accountFingerprint
    && left.billingRealm === right.billingRealm
    && left.requestedModelId === right.requestedModelId
    && left.canonicalModelId === right.canonicalModelId
    && left.resolutionState === right.resolutionState;
}

function exactEpochs(value: CodexRouteDispatchPermit["epochs"], epochs: Epochs, generation: number): boolean {
  return value.childGeneration === generation && value.profile === epochs.profile
    && value.home === epochs.home && value.route === epochs.route
    && value.model === epochs.model && value.account === epochs.account
    && value.auth === epochs.auth && value.plan === epochs.plan;
}

function requiresCurrentApprovalAuthority(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const decision = Object.getOwnPropertyDescriptor(value, "decision");
  return decision !== undefined && "value" in decision && decision.value === "accept";
}

function safeGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Codex child generation is invalid.");
  return value;
}

function safePlan(value: unknown): value is string {
  return typeof value === "string" && ["free", "go", "plus", "pro", "prolite", "team",
    "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu", "unknown"].includes(value);
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  const sortedExpected = [...expected].sort();
  return keys.every((key) => typeof key === "string"
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && "value" in Object.getOwnPropertyDescriptor(value, key)!)
    && keys.length === expected.length
    && [...keys].sort().every((key, index) => key === sortedExpected[index]);
}

function exactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => typeof key === "string" && allowed.has(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && "value" in Object.getOwnPropertyDescriptor(value, key)!)
    && keys.length >= required.length
    && keys.length <= required.length + optional.length;
}
