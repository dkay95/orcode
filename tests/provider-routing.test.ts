import assert from "node:assert/strict";
import test from "node:test";

import {
  BackendRegistry,
  type BackendAdapter,
  type BackendModelDescriptor,
  type ProviderInspection,
} from "../src/backends.js";
import {
  DefaultProviderRuntime,
  SessionProviderRuntimeGuard,
} from "../src/cli.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { KIMI_CODE_DESCRIPTOR } from "../src/kimi-code-backend.js";
import { OpenRouterService } from "../src/openrouter.js";
import {
  ANTHROPIC_COMING_SOON_DESCRIPTOR,
  OPENROUTER_DESCRIPTOR,
} from "../src/openrouter-backend.js";
import { ProviderStateStore, type ProviderSetupStateV3 } from "../src/provider-state.js";
import {
  createTerminalModelRoutePicker,
  type ChoicePickerItem,
  type TerminalUi,
} from "../src/tui.js";

const OPENROUTER_ROUTE = {
  version: 1 as const,
  backendId: "openrouter" as const,
  accountFingerprint: "acct_openrouter_catalog",
  billingRealm: "openrouter-payg" as const,
  requestedModelId: "vendor/known",
  canonicalModelId: "vendor/known",
  resolutionState: "resolved" as const,
};

const KIMI_ROUTE = {
  version: 1 as const,
  backendId: "kimi-code" as const,
  accountFingerprint: "acct_kimi_catalog",
  billingRealm: "kimi-code-membership-provider-managed-overage" as const,
  requestedModelId: "k3",
  canonicalModelId: "k3",
  resolutionState: "resolved" as const,
};

function health(backendId: "openrouter" | "kimi-code", generation: number) {
  return {
    credential: "valid" as const,
    connectivity: "connected" as const,
    spend: backendId === "openrouter" ? "available" as const : "unknown" as const,
    runtime: backendId === "openrouter" ? "ready" as const : "not-applicable" as const,
    observedAt: 1,
    generation,
  };
}

function fakeAdapter(
  backendId: "openrouter" | "kimi-code",
  accountFingerprint: string,
  models: readonly (BackendModelDescriptor & {
    readonly contextLength?: number;
    readonly price?: {
      readonly kind: "known";
      readonly promptUsdPerToken: number;
      readonly completionUsdPerToken: number;
    } | { readonly kind: "unknown" };
  })[],
  inspectionPatch: Partial<ProviderInspection> = {},
): BackendAdapter & {
  inspectUnderAuthorityLease(
    request: Parameters<BackendAdapter["inspect"]>[0],
    lease: { assertHeld(): Promise<void> },
  ): Promise<ProviderInspection>;
} {
  const inspect = async (
    request: Parameters<BackendAdapter["inspect"]>[0],
  ): Promise<ProviderInspection> => ({
    backendId,
    connectionId: request.connectionId,
    health: health(backendId, request.generation),
    headline: "ready",
    accountFingerprint,
    billingRealm: backendId === "openrouter"
      ? "openrouter-payg"
      : "kimi-code-membership-provider-managed-overage",
    routeEligible: true,
    retryable: false,
    explanationCode: "catalog-ready",
    ...inspectionPatch,
  });
  return {
    backendId,
    inspect,
    async inspectUnderAuthorityLease(request, lease) {
      await lease.assertHeld();
      return inspect(request);
    },
    async listModels() { return models; },
    async connect() { throw new Error("unused"); },
    async activate() { throw new Error("unused"); },
    async reconnect(request) { return inspect(request); },
    async logout() {},
    async discardCandidate() {},
  };
}

function runtimeWithFakeCatalog(options: {
  readonly duplicateOpenRouterOwner?: boolean;
  readonly openRouterInspectionPatch?: Partial<ProviderInspection>;
} = {}): DefaultProviderRuntime {
  const state: ProviderSetupStateV3 = {
    schemaVersion: 3,
    revision: 5,
    lifecycle: "configured",
    connections: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        backendId: "openrouter",
        enabled: true,
        maturity: "stable",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:11111111-1111-4111-8111-111111111111" },
        accountFingerprint: OPENROUTER_ROUTE.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: OPENROUTER_ROUTE.billingRealm,
        lastHealth: health("openrouter", 5),
      },
      ...(options.duplicateOpenRouterOwner ? [{
        id: "44444444-4444-4444-8444-444444444444",
        backendId: "openrouter" as const,
        enabled: true,
        maturity: "stable" as const,
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:44444444-4444-4444-8444-444444444444" },
        accountFingerprint: OPENROUTER_ROUTE.accountFingerprint,
        accountFingerprintState: "verified" as const,
        billingRealm: OPENROUTER_ROUTE.billingRealm,
        lastHealth: health("openrouter", 5),
      }] : []),
      {
        id: "22222222-2222-4222-8222-222222222222",
        backendId: "kimi-code",
        enabled: true,
        maturity: "preview",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:kimi-code:22222222-2222-4222-8222-222222222222" },
        accountFingerprint: KIMI_ROUTE.accountFingerprint,
        accountFingerprintState: "verified",
        billingRealm: KIMI_ROUTE.billingRealm,
        lastHealth: health("kimi-code", 5),
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        backendId: "openrouter",
        enabled: false,
        maturity: "stable",
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:33333333-3333-4333-8333-333333333333" },
        accountFingerprint: "acct_disabled_private_canary",
        accountFingerprintState: "verified",
        billingRealm: "openrouter-payg",
        lastHealth: health("openrouter", 5),
      },
    ],
    defaultRoute: OPENROUTER_ROUTE,
    cross: { enabled: false, preferredLead: null, preferredChallenger: null },
  };
  const openrouter = fakeAdapter("openrouter", OPENROUTER_ROUTE.accountFingerprint, [
    {
      backendId: "openrouter",
      requestedModelId: "vendor/known",
      canonicalModelId: "vendor/known",
      displayName: "Known Cost",
      contextLength: 128_000,
      price: { kind: "known", promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002 },
      capabilities: { textInput: true, textOutput: true, tools: true, reasoning: false },
    },
    {
      backendId: "openrouter",
      requestedModelId: "vendor/alias",
      canonicalModelId: "vendor/known",
      displayName: "Duplicate Alias",
      price: { kind: "unknown" },
      capabilities: { textInput: true, textOutput: true, tools: true, reasoning: false },
    },
    {
      backendId: "openrouter",
      requestedModelId: "vendor/no-tools",
      canonicalModelId: "vendor/no-tools",
      displayName: "No Tools",
      capabilities: { textInput: true, textOutput: true, tools: false, reasoning: false },
    },
  ], options.openRouterInspectionPatch);
  const kimi = fakeAdapter("kimi-code", KIMI_ROUTE.accountFingerprint, [{
    backendId: "kimi-code",
    requestedModelId: "k3",
    canonicalModelId: "k3",
    displayName: "Kimi K3",
    contextLength: 262_144,
    price: { kind: "unknown" },
    capabilities: { textInput: true, textOutput: true, tools: true, reasoning: true },
  }]);
  const registry = new BackendRegistry([
    { descriptor: OPENROUTER_DESCRIPTOR, adapter: openrouter },
    { descriptor: KIMI_CODE_DESCRIPTOR, adapter: kimi },
    { descriptor: ANTHROPIC_COMING_SOON_DESCRIPTOR },
  ]);
  const stateStore = new ProviderStateStore(state);
  const coordinator = {
    async readAuthority(
      _request: unknown,
      run: (lease: { assertHeld(): Promise<void> }) => Promise<unknown>,
    ) {
      return run({ async assertHeld() {} });
    },
  };
  const config = { ...structuredClone(DEFAULT_CONFIG), mainModel: OPENROUTER_ROUTE.requestedModelId, providerSetup: state };
  return new DefaultProviderRuntime(
    new OpenRouterService(),
    {} as never,
    registry,
    stateStore,
    {} as never,
    coordinator as never,
    new SessionProviderRuntimeGuard(),
    { async apply() { throw new Error("unused"); } },
    null,
    null,
    config.mainModel,
    config,
  );
}

test("provider route catalog enumerates mixed healthy adapters with safe exact display metadata", async () => {
  const runtime = runtimeWithFakeCatalog();
  const rows = await runtime.listSelectableModelRoutes("");

  assert.deepEqual(rows.map((row) => [
    row.providerLabel,
    row.route.backendId,
    row.route.requestedModelId,
    row.supportsTools,
    row.supportsReasoning,
    row.model.price.kind,
    row.selected,
  ]), [
    ["OpenRouter", "openrouter", "vendor/known", true, false, "known", true],
    ["Kimi Code", "kimi-code", "k3", true, true, "unknown", false],
  ]);
  assert.equal(rows[0]!.model.contextLength, 128_000);
  assert.deepEqual((await runtime.listSelectableModelRoutes("K3")).map(({ route }) => route.requestedModelId), ["k3"]);
  assert.deepEqual(
    (await runtime.listSelectableModelRoutes("vendor/alias")).map(({ route }) => route.requestedModelId),
    ["vendor/alias"],
    "an exact requested alias remains selectable after canonical de-duplication",
  );
  assert.doesNotMatch(JSON.stringify(rows), /disabled_private_canary|Anthropic|no-tools|Duplicate Alias/u);
});

test("provider route catalog rejects ambiguous owners and mismatched live inspection tuples", async (t) => {
  await t.test("duplicate exact route owner", async () => {
    const rows = await runtimeWithFakeCatalog({ duplicateOpenRouterOwner: true })
      .listSelectableModelRoutes("");
    assert.deepEqual(rows.map(({ route }) => route.backendId), ["kimi-code"]);
  });

  for (const [name, patch] of [
    ["backend", { backendId: "kimi-code" as const }],
    ["connection", { connectionId: "99999999-9999-4999-8999-999999999999" }],
    ["generation", { health: health("openrouter", 4) }],
  ] as const) {
    await t.test(name, async () => {
      const rows = await runtimeWithFakeCatalog({ openRouterInspectionPatch: patch })
        .listSelectableModelRoutes("");
      assert.deepEqual(rows.map(({ route }) => route.backendId), ["kimi-code"]);
    });
  }
});

test("shared picker preserves main Settings and Cross candidate order while compressor stays on the exact owner", async () => {
  const runtime = runtimeWithFakeCatalog();
  const snapshots: Array<{
    readonly role: "main" | "compressor" | "lead" | "challenger";
    readonly items: readonly ChoicePickerItem[];
  }> = [];
  let activeRole: "main" | "compressor" | "lead" | "challenger" = "main";
  const picker = createTerminalModelRoutePicker(
    {
      async pickChoice(_title, items) {
        snapshots.push({ role: activeRole, items: structuredClone(items) });
        return null;
      },
    } as Pick<TerminalUi, "pickChoice">,
    runtime,
    () => OPENROUTER_ROUTE,
  );

  for (const role of ["main", "main", "lead", "challenger"] as const) {
    activeRole = role;
    await picker.pickModelRoute({
      title: `${role} route`,
      role,
      current: OPENROUTER_ROUTE,
      preserveDraft: true,
    });
  }
  activeRole = "compressor";
  await picker.pickModelRoute({
    title: "compressor route",
    role: "compressor",
    current: OPENROUTER_ROUTE,
    preserveDraft: true,
  });

  const identities = (items: readonly ChoicePickerItem[]) => items.map((item) => [
    item.value,
    item.label,
    item.description,
  ]);
  const shared = identities(snapshots[0]!.items);
  assert.equal(shared.length, 2);
  assert.deepEqual(identities(snapshots[1]!.items), shared, "Settings main sees the command snapshot order");
  assert.deepEqual(identities(snapshots[2]!.items), shared, "Cross lead sees the command snapshot order");
  assert.deepEqual(identities(snapshots[3]!.items), shared, "Cross challenger sees the command snapshot order");
  assert.deepEqual(
    snapshots[4]!.items.map(({ label }) => label),
    ["OpenRouter · Known Cost"],
    "compressor never receives a foreign-provider candidate whose route cannot be persisted",
  );
});
