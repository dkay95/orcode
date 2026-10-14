/**
 * Non-authorizing notifications from the supported official Codex runtime.
 * Existing schemas remain closed; startup remote-control notification was
 * observed again in the signed 0.159.1 empty-profile probe on 2026-10-14.
 * They grant no tools, publication, model/account switch, or task completion.
 */
export const CODEX_PASSIVE_NOTIFICATION_METHODS = Object.freeze([
  "remoteControl/status/changed",
  "thread/status/changed", "thread/name/updated", "thread/tokenUsage/updated", "thread/closed",
  "turn/diff/updated", "turn/plan/updated", "item/plan/delta", "serverRequest/resolved",
  "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "item/commandExecution/outputDelta", "item/commandExecution/terminalInteraction",
  "account/rateLimits/updated", "thread/compacted",
] as const);

export function validCodexPassiveNotification(method: string, value: unknown): boolean {
  if (!record(value)) return false;
  const scoped = () => identifier(value.threadId) && identifier(value.turnId);
  switch (method) {
    case "remoteControl/status/changed":
      return keys(value, ["status", "installationId", "serverName"], ["environmentId"])
        && ["disabled", "connecting", "connected", "errored"].includes(value.status as string)
        && text(value.installationId) && text(value.serverName) && nullableText(value.environmentId);
    case "thread/status/changed":
      return keys(value, ["threadId", "status"]) && identifier(value.threadId) && threadStatus(value.status);
    case "thread/name/updated":
      return keys(value, ["threadId"], ["threadName"]) && identifier(value.threadId) && nullableText(value.threadName);
    case "thread/closed":
      return keys(value, ["threadId"]) && identifier(value.threadId);
    case "thread/compacted":
      return keys(value, ["threadId", "turnId"]) && scoped();
    case "item/commandExecution/outputDelta":
    case "item/plan/delta":
      return keys(value, ["threadId", "turnId", "itemId", "delta"])
        && scoped() && identifier(value.itemId) && text(value.delta);
    case "item/commandExecution/terminalInteraction":
      return keys(value, ["threadId", "turnId", "itemId", "processId", "stdin"])
        && scoped() && identifier(value.itemId) && identifier(value.processId) && text(value.stdin);
    case "item/reasoning/summaryTextDelta":
      return keys(value, ["threadId", "turnId", "itemId", "summaryIndex", "delta"])
        && scoped() && identifier(value.itemId) && integer(value.summaryIndex) && text(value.delta);
    case "item/reasoning/summaryPartAdded":
      return keys(value, ["threadId", "turnId", "itemId", "summaryIndex"])
        && scoped() && identifier(value.itemId) && integer(value.summaryIndex);
    case "item/reasoning/textDelta":
      return keys(value, ["threadId", "turnId", "itemId", "contentIndex", "delta"])
        && scoped() && identifier(value.itemId) && integer(value.contentIndex) && text(value.delta);
    case "turn/diff/updated":
      return keys(value, ["threadId", "turnId", "diff"]) && scoped() && text(value.diff);
    case "turn/plan/updated":
      return keys(value, ["threadId", "turnId", "plan"], ["explanation"]) && scoped()
        && nullableText(value.explanation) && Array.isArray(value.plan) && value.plan.length <= 1024
        && value.plan.every((step) => record(step) && keys(step, ["step", "status"])
          && text(step.step) && ["pending", "inProgress", "completed"].includes(step.status as string));
    case "thread/tokenUsage/updated":
      return keys(value, ["threadId", "turnId", "tokenUsage"]) && scoped() && tokenUsage(value.tokenUsage);
    case "serverRequest/resolved":
      return keys(value, ["threadId", "requestId"]) && identifier(value.threadId)
        && (identifier(value.requestId) || integer(value.requestId));
    case "account/rateLimits/updated":
      return keys(value, ["rateLimits"]) && rateLimitSnapshot(value.rateLimits);
    default:
      return false;
  }
}

function threadStatus(value: unknown): boolean {
  if (!record(value)) return false;
  if (["notLoaded", "idle", "systemError"].includes(value.type as string)) return keys(value, ["type"]);
  return keys(value, ["type", "activeFlags"]) && value.type === "active"
    && Array.isArray(value.activeFlags) && value.activeFlags.length <= 2
    && value.activeFlags.every((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
}

function tokenUsage(value: unknown): boolean {
  return record(value) && keys(value, ["total", "last"], ["modelContextWindow"])
    && breakdown(value.total) && breakdown(value.last) && nullableInteger(value.modelContextWindow);
}

function breakdown(value: unknown): boolean {
  return record(value) && keys(value, ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"])
    && Object.values(value).every(integer);
}

function rateLimitSnapshot(value: unknown): boolean {
  return record(value) && keys(value, [], ["credits", "individualLimit", "limitId", "limitName", "planType",
    "primary", "rateLimitReachedType", "secondary"])
    && nullableText(value.limitId) && nullableText(value.limitName)
    && (value.planType == null || ["free", "go", "plus", "pro", "prolite", "team",
      "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu", "unknown"].includes(value.planType as string))
    && (value.rateLimitReachedType == null || ["rate_limit_reached", "workspace_owner_credits_depleted",
      "workspace_member_credits_depleted", "workspace_owner_usage_limit_reached", "workspace_member_usage_limit_reached"].includes(value.rateLimitReachedType as string))
    && window(value.primary) && window(value.secondary)
    && (value.credits == null || record(value.credits) && keys(value.credits, ["hasCredits", "unlimited"], ["balance"])
      && typeof value.credits.hasCredits === "boolean" && typeof value.credits.unlimited === "boolean" && nullableText(value.credits.balance))
    && (value.individualLimit == null || record(value.individualLimit)
      && keys(value.individualLimit, ["limit", "remainingPercent", "resetsAt", "used"])
      && text(value.individualLimit.limit) && text(value.individualLimit.used)
      && integer(value.individualLimit.remainingPercent) && integer(value.individualLimit.resetsAt));
}

function window(value: unknown): boolean {
  return value == null || record(value) && keys(value, ["usedPercent"], ["resetsAt", "windowDurationMins"])
    && integer(value.usedPercent) && nullableInteger(value.resetsAt) && nullableInteger(value.windowDurationMins);
}
function text(value: unknown): value is string { return typeof value === "string" && value.length <= 1024 * 1024; }
function nullableText(value: unknown): boolean { return value == null || text(value); }
function identifier(value: unknown): value is string { return text(value) && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value); }
function integer(value: unknown): boolean { return Number.isSafeInteger(value); }
function nullableInteger(value: unknown): boolean { return value == null || integer(value); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const accepted = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every((key) =>
    typeof key === "string" && accepted.has(key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined);
}
