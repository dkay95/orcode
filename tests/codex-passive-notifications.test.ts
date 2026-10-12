import assert from "node:assert/strict";
import test from "node:test";
import { validCodexPassiveNotification } from "../src/codex-passive-notifications.js";

const scope = { threadId: "thread-1", turnId: "turn-1" };
const cases: Array<[string, Record<string, unknown>]> = [
  ["remoteControl/status/changed", { status: "disabled", installationId: "", serverName: "", environmentId: null }],
  ["thread/status/changed", { threadId: "thread-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } }],
  ["thread/name/updated", { threadId: "thread-1" }],
  ["thread/closed", { threadId: "thread-1" }],
  ["thread/compacted", scope],
  ["item/commandExecution/outputDelta", { ...scope, itemId: "cmd-1", delta: "output" }],
  ["item/commandExecution/terminalInteraction", { ...scope, itemId: "cmd-1", processId: "process-1", stdin: "yes\n" }],
  ["item/plan/delta", { ...scope, itemId: "plan-1", delta: "Inspect the file" }],
  ["item/reasoning/summaryTextDelta", { ...scope, itemId: "r-1", summaryIndex: 0, delta: "Summary" }],
  ["item/reasoning/summaryPartAdded", { ...scope, itemId: "r-1", summaryIndex: 0 }],
  ["item/reasoning/textDelta", { ...scope, itemId: "r-1", contentIndex: 0, delta: "Reasoning" }],
  ["turn/diff/updated", { ...scope, diff: "" }],
  ["turn/plan/updated", { ...scope, plan: [{ step: "Inspect", status: "inProgress" }] }],
  ["thread/tokenUsage/updated", { ...scope, tokenUsage: {
    total: { totalTokens: 7, inputTokens: 5, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 1 },
    last: { totalTokens: 7, inputTokens: 5, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 1 },
  } }],
  ["serverRequest/resolved", { threadId: "thread-1", requestId: 42 }],
  ["account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 80, resetsAt: null },
    credits: { hasCredits: false, unlimited: false }, planType: "pro", individualLimit: null } }],
];

for (const [method, params] of cases) test(`${method} requires its pinned shape and rejects private expansion`, () => {
  assert.equal(validCodexPassiveNotification(method, params), true);
  assert.equal(validCodexPassiveNotification(method, { ...params, credentialBinding: "private" }), false);
  if ("threadId" in params) assert.equal(validCodexPassiveNotification(method, { ...params, threadId: 8 }), false);
});

test("nested future fields and malformed usage cannot cross the passive boundary", () => {
  assert.equal(validCodexPassiveNotification("remoteControl/status/changed", {
    status: "allowAll", installationId: "id", serverName: "name",
  }), false);
  assert.equal(validCodexPassiveNotification("remoteControl/status/changed", {
    status: "disabled", installationId: 3, serverName: "name",
  }), false);
  assert.equal(validCodexPassiveNotification("thread/status/changed", {
    threadId: "t", status: { type: "active", activeFlags: ["allowAll"] },
  }), false);
  assert.equal(validCodexPassiveNotification("turn/plan/updated", {
    ...scope, plan: [{ step: "Inspect", status: "completed", authUrl: "private" }],
  }), false);
  assert.equal(validCodexPassiveNotification("account/rateLimits/updated", {
    rateLimits: { primary: { usedPercent: "80" } },
  }), false);
  assert.equal(validCodexPassiveNotification("account/rateLimits/updated", {
    rateLimits: { credits: { hasCredits: true, unlimited: true, accessToken: "private" } },
  }), false);
  assert.equal(validCodexPassiveNotification("model/rerouted", { ...scope, model: "unselected-model" }), false);
  assert.equal(validCodexPassiveNotification("unknown/future", {}), false);
});
