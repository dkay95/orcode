import assert from "node:assert/strict";
import test from "node:test";

import type { BackendModelDescriptor, RouteIdentityV1 } from "../src/backends.js";
import { parsePublicRoutePickerSelection, projectSelectableModelRoutes } from "../src/model-route-catalog.js";

function route(
  backendId: RouteIdentityV1["backendId"],
  requestedModelId: string,
): RouteIdentityV1 {
  return {
    version: 1,
    backendId,
    accountFingerprint: `acct_${backendId}`,
    billingRealm: backendId === "kimi-code"
      ? "kimi-code-membership-provider-managed-overage"
      : "openrouter-payg",
    requestedModelId,
    canonicalModelId: requestedModelId,
    resolutionState: "resolved",
  };
}

function descriptor(
  backendId: BackendModelDescriptor["backendId"],
  requestedModelId: string,
  capabilities: Partial<BackendModelDescriptor["capabilities"]> = {},
): BackendModelDescriptor {
  return {
    backendId,
    requestedModelId,
    canonicalModelId: requestedModelId,
    displayName: requestedModelId,
    capabilities: {
      textInput: true,
      textOutput: true,
      tools: true,
      reasoning: false,
      ...capabilities,
    },
  };
}

test("provider-aware route catalog projects only resolved tool-capable routes in stable identity order", () => {
  const current = route("openrouter", "openai/current");
  const rows = projectSelectableModelRoutes([
    {
      providerLabel: "OpenRouter",
      route: route("openrouter", "openai/current"),
      model: descriptor("openrouter", "openai/current", { reasoning: true }),
      price: { kind: "known", promptUsdPerToken: 0.000_001, completionUsdPerToken: 0.000_002 },
    },
    {
      providerLabel: "Kimi Code",
      route: route("kimi-code", "k3"),
      model: descriptor("kimi-code", "k3", { reasoning: true }),
      price: { kind: "unknown" },
    },
    {
      providerLabel: "OpenRouter",
      route: route("openrouter", "image-only"),
      model: descriptor("openrouter", "image-only", { tools: false }),
      price: { kind: "known", promptUsdPerToken: 0, completionUsdPerToken: 0 },
    },
  ], current);

  assert.deepEqual(rows.map((row) => ({
    backendId: row.route.backendId,
    model: row.route.canonicalModelId,
    provider: row.providerLabel,
    tools: row.supportsTools,
    reasoning: row.supportsReasoning,
    selected: row.selected,
    price: row.model.price.kind,
  })), [
    {
      backendId: "openrouter",
      model: "openai/current",
      provider: "OpenRouter",
      tools: true,
      reasoning: true,
      selected: true,
      price: "known",
    },
    {
      backendId: "kimi-code",
      model: "k3",
      provider: "Kimi Code",
      tools: true,
      reasoning: true,
      selected: false,
      price: "unknown",
    },
  ]);
  assert.equal(rows[0]!.model.reasoning !== undefined, true);
  assert.equal(rows[1]!.model.reasoning !== undefined, true);
});

test("public picker selection accepts only the opaque three-field intent", () => {
  assert.deepEqual(parsePublicRoutePickerSelection({ handle: "opaque", revision: 7, generation: 4 }), {
    handle: "opaque", revision: 7, generation: 4,
  });
  assert.equal(parsePublicRoutePickerSelection({
    handle: "opaque", revision: 7, generation: 4, route: route("openrouter", "private"),
  }), null);
  assert.equal(parsePublicRoutePickerSelection({ handle: "", revision: 7, generation: 4 }), null);
});

test("provider-aware route catalog keeps non-reasoning metadata false and rejects terminal-controlled IDs", () => {
  const safe = route("openrouter", "vendor/safe");
  const controlled = route("openrouter", "vendor/unsafe\u001b[31m");
  const rows = projectSelectableModelRoutes([
    {
      providerLabel: "Open\u001b[31m\u202eRouter",
      route: safe,
      model: {
        ...descriptor("openrouter", "vendor/safe", { reasoning: false }),
        displayName: "Safe\u001b]0;forged\u0007\u202e Name",
      },
      price: { kind: "unknown" },
    },
    {
      providerLabel: "OpenRouter",
      route: controlled,
      model: descriptor("openrouter", controlled.requestedModelId),
      price: { kind: "unknown" },
    },
    {
      providerLabel: "OpenRouter",
      route: route("openrouter", "vendor/\u202eevil"),
      model: descriptor("openrouter", "vendor/\u202eevil"),
      price: { kind: "unknown" },
    },
  ], safe);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.model.reasoning, undefined);
  assert.equal(rows[0]!.supportsReasoning, false);
  assert.equal(rows[0]!.providerLabel, "OpenRouter");
  assert.equal(rows[0]!.model.name, "Safe Name");
  assert.doesNotMatch(JSON.stringify(rows), /\u001b|\u202e|forged/u);
});
