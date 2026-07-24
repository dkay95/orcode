import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  isApprovalMode,
  isCompressionMode,
  validateConfig,
} from "../src/config.js";

test("validateConfig preserves valid values", () => {
  const config = validateConfig({
    ...DEFAULT_CONFIG,
    mainModel: "anthropic/example",
    approvalMode: "allow-all",
    compressionMode: "always",
    maxSteps: 25,
    maxCostUsd: 2.5,
    reasoningByModel: {
      "anthropic/example": { mode: "effort", effort: "high" },
      "openrouter/auto": { mode: "budget", maxTokens: 8_000 },
    },
  });

  assert.equal(config.mainModel, "anthropic/example");
  assert.equal(config.approvalMode, "allow-all");
  assert.equal(config.compressionMode, "always");
  assert.equal(config.maxSteps, 25);
  assert.equal(config.maxCostUsd, 2.5);
  assert.deepEqual(config.reasoningByModel["anthropic/example"], {
    mode: "effort",
    effort: "high",
  });
});

test("validateConfig rejects unsafe or nonsensical persisted values", () => {
  const config = validateConfig({
    ...DEFAULT_CONFIG,
    approvalMode: "anything" as never,
    compressionMode: "magic" as never,
    maxSteps: 0,
    maxCostUsd: -1,
    compressionThresholdChars: 3,
    reasoningByModel: {
      broken: { mode: "effort", effort: "ultrahigh" as never },
      negative: { mode: "budget", maxTokens: -1 },
    },
  });

  assert.equal(config.approvalMode, DEFAULT_CONFIG.approvalMode);
  assert.equal(config.compressionMode, DEFAULT_CONFIG.compressionMode);
  assert.equal(config.maxSteps, DEFAULT_CONFIG.maxSteps);
  assert.equal(config.maxCostUsd, DEFAULT_CONFIG.maxCostUsd);
  assert.equal(
    config.compressionThresholdChars,
    DEFAULT_CONFIG.compressionThresholdChars,
  );
  assert.deepEqual(config.reasoningByModel, {});
});

test("mode guards accept only documented modes", () => {
  assert.equal(isApprovalMode("auto-edit"), true);
  assert.equal(isApprovalMode("yolo"), false);
  assert.equal(isCompressionMode("auto"), true);
  assert.equal(isCompressionMode("sometimes"), false);
});
