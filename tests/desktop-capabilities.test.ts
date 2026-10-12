import assert from "node:assert/strict";
import test from "node:test";

import { projectDesktopCapabilities, type DesktopCapabilityInput } from "../src/desktop-capabilities.js";
import { createAttestedDesktopKimiFixture } from "./kimi-desktop-capability-fixture.js";

test("projects only current, secretless provider truth", () => {
  const input = authorityProjectionFixture({
    revision: 7,
    generation: 3,
    credentialBinding: {
      pointer: "owner-store://private-pointer-canary",
      homeId: "private-home-canary",
      codexHome: "/private/codex-home-canary",
      codexAccountId: "abcdef0123456789abcdef0123456789",
      accountFingerprint: "abcdef0123456789abcdef0123456789",
    },
  });
  const serializedInput = JSON.stringify(input);
  assert.match(serializedInput, /credentialBinding/);
  assert.match(serializedInput, /pointer/);
  assert.match(serializedInput, /homeId/);
  assert.match(serializedInput, /codexHome/);
  assert.match(serializedInput, /abcdef0123456789abcdef0123456789/);

  const snapshot = projectDesktopCapabilities(input);

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    revision: 7,
    generation: 3,
    routeRunnable: true,
    providers: [{
      providerId: "openrouter", providerLabel: "OpenRouter", connectionId: "connection-1",
      accountLabel: "Persönliches OpenRouter", state: "ready",
      setupMethods: ["openrouter-owner-connect"],
      multiProfile: { enabled: true },
      routes: [{
        handle: "m-1", providerId: "openrouter", connectionId: "connection-1",
        accountLabel: "Persönliches OpenRouter", canonicalModelId: "openrouter/model",
        displayName: "Model", reasoning: "unknown", capabilities: ["text"],
        cost: { kind: "unknown", label: "Kosten unbekannt" },
        dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" },
        runnable: true,
      }],
    }],
    activeRoute: {
      routeHandle: "m-1", providerLabel: "OpenRouter",
      modelLabel: "Model", accountLabel: "Persönliches OpenRouter",
    },
    undoAvailable: false,
    appearance: { showLargeLogo: true, showHeaderMark: true },
  });
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /credentialBinding|pointer|homeId|codexHome|codexAccountId|abcdef0123456789abcdef0123456789|secret|fingerprint|token|@/i,
  );
});

test("projects data-policy knowledge through safe German copy or an honest unknown", () => {
  const known = projectDesktopCapabilities(authorityProjectionFixture({
    revision: 8,
    generation: 4,
    dataPolicy: {
      source: "provider",
      label: "Provider-Angabe zur Datennutzung",
      rawBody: "private-provider-body",
    },
  })).providers[0]!.routes[0]!.dataPolicy;
  assert.deepEqual(known, {
    kind: "known", label: "Provider-Angabe zur Datennutzung", source: "provider",
  });
  assert.doesNotMatch(JSON.stringify(known), /rawBody|private-provider-body/);

  const unknown = projectDesktopCapabilities(authorityProjectionFixture({
    revision: 9,
    generation: 5,
    dataPolicy: null,
  })).providers[0]!.routes[0]!.dataPolicy;
  assert.deepEqual(unknown, { kind: "unknown", label: "Datenrichtlinie unbekannt" });
});

test("whitelists nested capability fields instead of retaining authority objects", () => {
  const input = authorityProjectionFixture();
  const snapshot = projectDesktopCapabilities(input);

  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private-appearance-token|private-multi-profile-pointer/,
  );
  assert.deepEqual(snapshot.appearance, { showLargeLogo: true, showHeaderMark: true });
  assert.deepEqual(snapshot.providers[0]!.multiProfile, { enabled: true });
});

test("projects one required secretless label for OpenRouter Kimi and Codex providers", () => {
  const cases = [
    { providerId: "openrouter", providerLabel: "OpenRouter" },
    { providerId: "kimi-code", providerLabel: "Kimi Code" },
    { providerId: "codex", providerLabel: "ChatGPT Codex" },
  ] as const;

  for (const { providerId, providerLabel } of cases) {
    const input = authorityProjectionFixture();
    const mutable = mutableFixture(input);
    (input.state.connections[0] as { backendId: string }).backendId = providerId;
    mutable.providers[0]!.providerId = providerId;
    mutable.providers[0]!.providerLabel = providerLabel;
    mutable.providers[0]!.connection!.backendId = providerId;
    mutable.providers[0]!.routes[0]!.providerId = providerId;
    mutable.activeRoute!.providerLabel = providerLabel;
    assert.equal(projectDesktopCapabilities(input).providers[0]!.providerLabel, providerLabel);
  }
});

test("fails closed for unsafe display and disabled labels while downgrading unsafe knowledge", () => {
  const unsafeKnowledge = authorityProjectionFixture({
    dataPolicy: {
      source: "provider",
      label: "https://private.example/provider-body",
      rawBody: "private-provider-body",
    },
  });
  assert.deepEqual(
    projectDesktopCapabilities(unsafeKnowledge).providers[0]!.routes[0]!.dataPolicy,
    { kind: "unknown", label: "Datenrichtlinie unbekannt" },
  );

  const cases: Array<(input: MutableFixture) => void> = [
    (input) => { delete (input.providers[0]! as { providerLabel?: string }).providerLabel; },
    (input) => { input.providers[0]!.providerLabel = ""; },
    (input) => { input.providers[0]!.providerLabel = "https://private.example/provider"; },
    (input) => { input.providers[0]!.providerLabel = "owner@example.test"; },
    (input) => { input.providers[0]!.providerLabel = "PROVIDER_LABEL_CANARY"; },
    (input) => { input.providers[0]!.accountLabel = "owner@example.test"; },
    (input) => { input.providers[0]!.routes[0]!.accountLabel = "owner@example.test"; },
    (input) => { input.providers[0]!.routes[0]!.displayName = "Error: private-provider-diagnostic"; },
    (input) => { input.activeRoute!.providerLabel = "https://private.example/provider"; },
    (input) => { input.activeRoute!.modelLabel = "sk-or-v1-12345678901234567890"; },
    (input) => { input.activeRoute!.accountLabel = "abcdef0123456789abcdef0123456789"; },
    (input) => { input.providers[0]!.disabled = { code: "provider-blocked", label: "owner@example.test" }; },
    (input) => { input.providers[0]!.repair = { code: "provider-degraded", label: "Sicher", recoveryLabel: "https://private.example/recover" }; },
    (input) => { input.providers[0]!.routes[0]!.disabled = { code: "model-not-runnable", label: "Error: private-provider-diagnostic" }; },
    (input) => { input.providers[0]!.multiProfile.disabled = { code: "provider-disabled", label: "owner@example.test" }; },
  ];

  for (const mutate of cases) {
    const input = authorityProjectionFixture();
    mutate(mutableFixture(input));
    assert.throws(
      () => projectDesktopCapabilities(input),
      (error: unknown) => {
        assert.match(String(error), /Desktop-Daten konnten nicht sicher dargestellt werden/);
        assert.doesNotMatch(String(error), /owner@example|private-provider|private\.example|abcdef0123456789abcdef0123456789|sk-or/i);
        return true;
      },
    );
  }
});

test("forces every Kimi capability unavailable until native local control exists", () => {
  const input = authorityProjectionFixture();
  const mutable = mutableFixture(input);
  (input.state.connections[0] as { backendId: string }).backendId = "kimi-code";
  mutable.providers[0]!.providerId = "kimi-code";
  mutable.providers[0]!.connection!.backendId = "kimi-code";
  mutable.providers[0]!.state = "ready";
  mutable.providers[0]!.routes[0]!.providerId = "kimi-code";
  mutable.providers[0]!.routes[0]!.runnable = true;
  mutable.activeRoute!.routeHandle = "m-1";
  mutable.routeRunnable = true;

  const snapshot = projectDesktopCapabilities(input);
  const provider = snapshot.providers[0]!;
  assert.equal(provider.state, "disabled");
  assert.deepEqual(provider.disabled, {
    code: "native-local-action-unavailable",
    label: "Lokale Bestätigung ist nicht verfügbar",
    recoveryLabel: "Signierte Desktop-App verwenden",
  });
  assert.equal(provider.routes[0]!.runnable, false);
  assert.deepEqual(provider.routes[0]!.disabled, provider.disabled);
  assert.equal(snapshot.routeRunnable, false);
  assert.equal(snapshot.activeRoute, null);
});

test("Kimi projection accepts only a live privately minted runtime capability across provider epochs", async () => {
  const forgedBoolean = kimiAuthorityProjectionFixture(31);
  const forgedBooleanInput: DesktopCapabilityInput = {
    ...forgedBoolean,
    // @ts-expect-error A naked readiness bit is never projection authority.
    packagedRuntimeReady: true,
  };
  assert.equal(projectDesktopCapabilities(forgedBooleanInput).providers[0]!.state, "disabled");

  const fixture = await createAttestedDesktopKimiFixture({
    generation: 31,
    now: () => 1_775_000_000_000,
    emitRequirement() {},
    onAction() { return null; },
  });
  try {
    const nominal = {
      ...kimiAuthorityProjectionFixture(31),
      desktopKimiCapability: fixture.capability,
    };
    const ready = projectDesktopCapabilities(nominal);
    assert.equal(ready.providers[0]!.state, "ready");
    assert.equal(ready.providers[0]!.routes[0]!.runnable, true);
    assert.equal(ready.routeRunnable, true);

    const structuralCopy = {
      ...fixture.capability,
      extra: true,
    };
    const copied = projectDesktopCapabilities({
      ...kimiAuthorityProjectionFixture(31),
      desktopKimiCapability: structuralCopy,
    } as never);
    assert.equal(copied.providers[0]!.state, "disabled");
    assert.equal(copied.routeRunnable, false);

    const laterProviderEpoch = projectDesktopCapabilities({
      ...kimiAuthorityProjectionFixture(32),
      desktopKimiCapability: fixture.capability,
    });
    assert.equal(laterProviderEpoch.generation, 32);
    assert.equal(laterProviderEpoch.providers[0]!.state, "ready");
    assert.equal(laterProviderEpoch.providers[0]!.routes[0]!.runnable, true);
    assert.equal(laterProviderEpoch.routeRunnable, true);
  } finally {
    await fixture.close();
  }

  const replayedAfterClose = projectDesktopCapabilities({
    ...kimiAuthorityProjectionFixture(31),
    desktopKimiCapability: fixture.capability,
  });
  assert.equal(replayedAfterClose.providers[0]!.state, "disabled");
  assert.equal(replayedAfterClose.routeRunnable, false);
});

const rejectedLegacyAttestationInput: DesktopCapabilityInput = {
  ...authorityProjectionFixture(),
  // @ts-expect-error A raw startup attestation is never projection authority.
  packagedRuntimeAttestation: Object.freeze({ kind: "packaged-attestation" }),
};
void rejectedLegacyAttestationInput;

test("fails closed when the active route is stale, disabled, or not runnable", () => {
  const stale = authorityProjectionFixture();
  mutableFixture(stale).activeRoute!.routeHandle = "stale-handle";
  assert.deepEqual(projectDesktopCapabilities(stale).activeRoute, null);
  assert.equal(projectDesktopCapabilities(stale).routeRunnable, false);

  const disabled = authorityProjectionFixture();
  mutableFixture(disabled).providers[0]!.routes[0]!.disabled = {
    code: "model-not-runnable",
    label: "Modell ist nicht verfügbar",
  };
  assert.equal(projectDesktopCapabilities(disabled).activeRoute, null);
  assert.equal(projectDesktopCapabilities(disabled).routeRunnable, false);

  const notRunnable = authorityProjectionFixture();
  mutableFixture(notRunnable).providers[0]!.routes[0]!.runnable = false;
  assert.equal(projectDesktopCapabilities(notRunnable).activeRoute, null);
  assert.equal(projectDesktopCapabilities(notRunnable).routeRunnable, false);
});

test("fails closed when active-route provider model or account copy disagrees with its candidate", () => {
  const cases: Array<(input: MutableFixture) => void> = [
    (input) => { input.activeRoute!.providerLabel = "Kimi Code"; },
    (input) => { input.activeRoute!.modelLabel = "Anderes Modell"; },
    (input) => { input.activeRoute!.accountLabel = "Anderes Konto"; },
  ];

  for (const mutate of cases) {
    const input = authorityProjectionFixture();
    mutate(mutableFixture(input));
    const snapshot = projectDesktopCapabilities(input);
    assert.equal(snapshot.activeRoute, null);
    assert.equal(snapshot.routeRunnable, false);
  }
});

test("rejects contradictory non-secret connection truth without exposing it", () => {
  const input = authorityProjectionFixture();
  mutableFixture(input).providers[0]!.connectionId = "connection-other";

  assert.throws(
    () => projectDesktopCapabilities(input),
    (error: unknown) => {
      assert.match(String(error), /Desktop-Daten konnten nicht sicher dargestellt werden/);
      assert.doesNotMatch(String(error), /connection-other/);
      return true;
    },
  );
});

interface MutableFixture {
  routeRunnable: boolean;
  providers: MutableProvider[];
  activeRoute: {
    routeHandle: string;
    providerLabel: string;
    modelLabel: string;
    accountLabel: string | null;
  } | null;
}

interface MutableProvider {
  providerId: string;
  providerLabel: string;
  connection: { backendId: string } | null;
  connectionId: string | null;
  accountLabel: string;
  state: string;
  multiProfile: {
    enabled: boolean;
    disabled?: { code: string; label: string; recoveryLabel?: string };
  };
  routes: Array<{
    providerId: string;
    accountLabel: string;
    displayName: string;
    runnable: boolean;
    disabled?: { code: string; label: string; recoveryLabel?: string };
  }>;
  disabled?: { code: string; label: string; recoveryLabel?: string };
  repair?: { code: string; label: string; recoveryLabel?: string };
}

function mutableFixture(input: ReturnType<typeof authorityProjectionFixture>): MutableFixture {
  return input as unknown as MutableFixture;
}

function kimiAuthorityProjectionFixture(generation: number) {
  const input = authorityProjectionFixture({ generation });
  const mutable = mutableFixture(input);
  (input.state.connections[0] as { backendId: string }).backendId = "kimi-code";
  mutable.providers[0]!.providerId = "kimi-code";
  mutable.providers[0]!.providerLabel = "Kimi Code";
  mutable.providers[0]!.connection!.backendId = "kimi-code";
  mutable.providers[0]!.state = "ready";
  mutable.providers[0]!.routes[0]!.providerId = "kimi-code";
  mutable.providers[0]!.routes[0]!.runnable = true;
  mutable.activeRoute!.providerLabel = "Kimi Code";
  return input;
}

function authorityProjectionFixture(overrides: {
  readonly revision?: number;
  readonly generation?: number;
  readonly credentialBinding?: Record<string, string>;
  readonly dataPolicy?: {
    readonly source: "provider" | "owner-config";
    readonly label: string;
    readonly rawBody: string;
  } | null;
} = {}) {
  const revision = overrides.revision ?? 1;
  const dataPolicy = overrides.dataPolicy === undefined
    ? null
    : overrides.dataPolicy;
  return {
    state: {
      schemaVersion: 3 as const,
      revision,
      lifecycle: "configured" as const,
      connections: [{
        id: "connection-1",
        backendId: "openrouter" as const,
        enabled: true,
        maturity: "stable" as const,
        credentialBinding: { kind: "orcode-keychain" as const, pointer: "v1:inference:private-slot-canary" },
        accountFingerprint: "abcdef0123456789abcdef0123456789",
        accountFingerprintState: "verified" as const,
        billingRealm: "openrouter-payg" as const,
        lastHealth: null,
      }],
      defaultRoute: null,
      cross: { enabled: false as const, preferredLead: null, preferredChallenger: null },
    },
    generation: overrides.generation ?? 1,
    routeRunnable: true,
    providers: [{
      providerId: "openrouter",
      providerLabel: "OpenRouter",
      connection: {
        id: "connection-1",
        backendId: "openrouter" as const,
        enabled: true,
        maturity: "stable" as const,
        billingRealm: "openrouter-payg" as const,
        lastHealth: null,
      },
      connectionId: "connection-1",
      accountLabel: "Persönliches OpenRouter",
      state: "ready" as const,
      setupMethods: ["openrouter-owner-connect"] as const,
      multiProfile: {
        enabled: true,
        authorityOnlyPointer: "private-multi-profile-pointer",
      },
      credentialBinding: overrides.credentialBinding,
      routes: [{
        handle: "m-1",
        providerId: "openrouter",
        connectionId: "connection-1",
        accountLabel: "Persönliches OpenRouter",
        canonicalModelId: "openrouter/model",
        displayName: "Model",
        reasoning: "unknown" as const,
        capabilities: ["text"] as const,
        cost: null,
        dataPolicy,
        runnable: true,
      }],
    }],
    activeRoute: {
      routeHandle: "m-1",
      providerLabel: "OpenRouter",
      modelLabel: "Model",
      accountLabel: "Persönliches OpenRouter",
      routeIdentity: {
        accountFingerprint: "abcdef0123456789abcdef0123456789",
      },
    },
    undoAvailable: false,
    appearance: {
      showLargeLogo: true,
      showHeaderMark: true,
      authorityOnlyToken: "private-appearance-token",
    },
    credentialBinding: overrides.credentialBinding,
  };
}
