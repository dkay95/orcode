# Orcode Startup and OpenRouter Setup Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the releasable Slice 1 foundation: bounded per-start OpenRouter health inspection, a reusable first-run/repair hub, versioned provider state and exact route identity, safe OpenRouter credential replacement, and a truthful Anthropic Coming-soon entry.

**Architecture:** New provider-domain modules sit between `src/cli.ts`/`src/commands.ts` and the existing `OpenRouterService`. `BackendRegistry` describes available backends, `ProviderStateStore` owns validated non-secret state plus crash recovery, `OpenRouterBackendAdapter` translates existing OpenRouter operations into provider health/candidates, and `SetupOrchestrator` is the surface-neutral state machine. Plain and fullscreen presenters consume the same intents/events; the existing OpenRouter agent remains the only execution backend in this slice.

**Tech Stack:** Node.js 22, TypeScript 5.9, `node:test`, `@inquirer/prompts`, existing `@napi-rs/keyring`, existing `PrivateStore`, existing `TerminalUi`; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-23-orcode-startup-provider-setup-design.md`

## Global Constraints

- This plan implements **Slice 1 only**. It must not launch Codex, start a ChatGPT login, import an Anthropic token, or add a direct Anthropic/OpenAI API-key path.
- OpenRouter is the only runnable backend in this slice. Anthropic is a descriptor with `maturity: "coming-soon"`, `connectable: false`, and no adapter. Codex is an ID/type reserved for Slice 2, not a registered runnable adapter here.
- Every ordinary start inspects only enabled adapters. `--help` and `--version` perform zero storage migration, keychain access, executable discovery, or network calls.
- Default provider timeout is 5,000 ms and must be bounded to 15,000 ms. Default whole-startup timeout is 8,000 ms and must be bounded to 30,000 ms.
- The spec's 10-minute managed-login and 5-second child-drain gates belong to Slice 2 because Slice 1 starts no provider-owned login process. This plan must not claim those runtime gates; it only preserves an adapter contract where Slice 2 can implement them.
- Startup inspection performs only documented metadata operations. It must never create a model request, provider charge, chat turn, or run event.
- A saved OpenRouter inference key is authoritative whenever present. `OPENROUTER_API_KEY` is never automatically validated while a saved key exists, including after that saved key is rejected.
- With no saved key, an environment key may be validated for the process but is never persisted without a later explicit save action.
- Only inference `/key` HTTP 401 is `auth-rejected`. HTTP 403, 429, 5xx, DNS/TLS failure, offline, timeout, and management `/credits` failure retain the inference credential and remain retryable/unknown as specified.
- The legacy keychain service name `de.routercode.openrouter`, legacy inference account, legacy management account, app-home selection, and `routercode` executable alias remain unchanged.
- Provider state never stores a raw key, token, email, provider response, credential path, or raw account ID. Fingerprints are local HMAC values using a keychain-held 256-bit local key.
- `config.provider` remains OpenRouter endpoint-routing policy only. No provider/account/billing-realm meaning may be added to it.
- Keep the existing top-level config/storage schema version unchanged. `providerSetup.schemaVersion` is an independently validated nested version; migration must not reopen the app-home schema contract.
- Cross stays off through setup, migration, repair, restart, and reconnect. Role preparation may persist two preferred routes but must not start collaboration.
- Interactive setup cancellation leaves the chat alive in `setup-required`; model-independent slash commands remain available. Non-interactive modes return typed `provider-setup-required` with exit code 1 and never prompt.
- Future or corrupt nested provider-state schemas fail closed and cannot be overwritten by unrelated config saves.
- Every candidate activation is old-or-new across crash/restart. A failed candidate never overwrites or deletes the active route or active key slot.
- Provider activation, default replacement, disable, and logout require the affected adapter to be idle and drained; an active run is never rebound.
- All secret-entry paths use one normalization function: strip only outer Unicode whitespace/CRLF; reject remaining whitespace, NUL, ANSI escape, and control characters before any network or store call.
- Do not claim a native Windows keychain/DACL/PTTY result from macOS. Deterministic adapters are unit coverage; real-platform claims require their platform gate.
- Preserve the untracked `.superpowers/brainstorm/` directory; never stage, delete, or rewrite it.

## File Structure

**Create**

- `src/backends.ts` — provider-domain types, route identity, health reduction, descriptors, adapter contract, and registry.
- `src/provider-state.ts` — nested provider-state schema, validation, legacy OpenRouter migration/projection, account fingerprinting, and config-backed state store.
- `src/provider-activation.ts` — versioned keychain-slot/config-pointer transaction journal and startup recovery.
- `src/openrouter-backend.ts` — Slice-1 OpenRouter descriptor/adapter and Anthropic Coming-soon descriptor.
- `src/setup.ts` — generation-aware startup/setup state machine, deadlines, typed intents/events/errors.
- `src/setup-ui.ts` — common setup-hub runner plus plain and fullscreen surface adapters.
- `tests/backends.test.ts`
- `tests/provider-state.test.ts`
- `tests/provider-activation.test.ts`
- `tests/openrouter-backend.test.ts`
- `tests/setup.test.ts`
- `tests/setup-ui.test.ts`
- `tests/provider-setup-pty.test.ts`
- `tests/provider-privacy.test.ts`
- `tests/fixtures/provider-setup-pty-harness.mjs`

**Modify**

- `src/types.ts` — documented OpenRouter account identity metadata and optional structured session route.
- `src/config.ts` — nested provider state in `OrcodeConfigWithBudget`, source-aware migration, future/corrupt refusal, atomic save integration.
- `src/credentials.ts` — shared secret normalization, versioned slots, local HMAC key, legacy-slot compatibility.
- `src/openrouter.ts` — parse documented `creator_user_id`, expose candidate-safe inspection, expiry-aware health without mutating active state.
- `src/cli.ts` — help/version application boundary, provider bootstrap, setup-required loops, non-interactive typed failure, fullscreen/plain presenters.
- `src/commands.ts` — setup controller seam, `/provider` backend subcommands, route-aware `/key` and `/model` activation.
- `src/command-catalog.ts` — provider usage/description only; root command identity remains unchanged.
- `src/tui.ts` — preserve raw secret input until common normalization and expose setup picker through existing choice/model/confirm primitives.
- `src/session.ts` — derive/persist an OpenRouter route for legacy session-model preferences without changing transcript semantics.
- `src/private-store.ts` — add one root-bound exclusive-directory primitive for the provider setup lease; no raw unresolved lock path.
- `README.md` — regenerated command table and truthful Stable/Coming-soon setup explanation.
- `tests/config.test.ts`
- `tests/credentials.test.ts`
- `tests/openrouter.test.ts`
- `tests/cli.test.ts`
- `tests/cli-entrypoint.test.ts`
- `tests/commands.test.ts`
- `tests/commands-catalog.test.ts`
- `tests/tui.test.ts`
- `tests/session.test.ts`
- `tests/app-home-migration.test.ts`
- `tests/integration.test.ts`
- `tests/private-store.test.ts`
- `tests/private-store-identity-races.test.ts`
- `scripts/render-command-docs.ts` only if its renderer needs a non-row prose marker; do not add a second command table.

---

### Task 1: Provider Domain Contracts and Registry

**Files:**
- Create: `src/backends.ts`
- Create: `tests/backends.test.ts`

**Interfaces:**
- Consumes: `ModelInfo` from `src/types.ts`; `AbortSignal`; no CLI, TUI, credential, config, or OpenRouter implementation.
- Produces: `BackendId`, `BillingRealm`, `RouteIdentityV1`, `ProviderHealth`, `ProviderHeadline`, `BackendDescriptor`, `BackendAdapter`, `BackendRegistry`, `deriveProviderHeadline`, `ProviderComingSoonError`, and `ProviderSetupRequiredError`.

- [ ] **Step 1: Write the failing domain tests**

Create table-driven tests that pin the public shapes and health precedence:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  BackendRegistry,
  ProviderComingSoonError,
  deriveProviderHeadline,
  sameRoute,
  type BackendDescriptor,
  type ProviderHealth,
  type RouteIdentityV1,
} from "../src/backends.js";

const ready: ProviderHealth = {
  credential: "valid",
  connectivity: "connected",
  spend: "available",
  runtime: "not-applicable",
  observedAt: 100,
  generation: 7,
};

test("health dimensions reduce without turning unknown transport into auth rejection", () => {
  assert.equal(deriveProviderHeadline(ready), "ready");
  assert.equal(deriveProviderHeadline({ ...ready, spend: "unknown" }), "ready");
  assert.equal(deriveProviderHeadline({ ...ready, credential: "login-required" }), "login-required");
  assert.equal(deriveProviderHeadline({ ...ready, credential: "rejected" }), "auth-rejected");
  assert.equal(deriveProviderHeadline({ ...ready, credential: "expired" }), "credential-expired");
  assert.equal(deriveProviderHeadline({ ...ready, connectivity: "offline" }), "offline");
  assert.equal(deriveProviderHeadline({ ...ready, runtime: "missing" }), "runtime-missing");
  assert.equal(deriveProviderHeadline({ ...ready, runtime: "incompatible" }), "incompatible-runtime");
  assert.equal(deriveProviderHeadline({ ...ready, runtime: "policy-unavailable" }), "policy-unavailable");
  assert.equal(deriveProviderHeadline({ ...ready, spend: "limit-reached" }), "limit-reached");
  assert.equal(deriveProviderHeadline({ ...ready, credential: "unknown", connectivity: "unknown" }), "unknown");
});

test("route identity compares backend account realm and canonical model", () => {
  const route: RouteIdentityV1 = {
    version: 1,
    backendId: "openrouter",
    accountFingerprint: "acct_local_a",
    billingRealm: "openrouter-payg",
    requestedModelId: "openai/gpt",
    canonicalModelId: "openai/gpt-2026",
    resolutionState: "resolved",
  };
  assert.equal(sameRoute(route, { ...route }), true);
  assert.equal(sameRoute(route, { ...route, accountFingerprint: "acct_local_b" }), false);
  assert.equal(sameRoute(route, { ...route, backendId: "codex" }), false);
});

test("coming-soon descriptors have no adapter and reject connect structurally", () => {
  const descriptor: BackendDescriptor = {
    id: "anthropic",
    displayName: "Anthropic / Claude-Abo",
    maturity: "coming-soon",
    connectable: false,
    kind: "managed-agent",
    credentialOwner: "none",
    billingRealmKind: "none",
    capabilities: { models: false, tools: false, reasoning: false },
  };
  const registry = new BackendRegistry([{ descriptor }]);
  assert.equal(registry.descriptor("anthropic").maturity, "coming-soon");
  assert.throws(() => registry.adapter("anthropic"), ProviderComingSoonError);
});
```

Also assert duplicate descriptor IDs, adapter/descriptor ID mismatches, a connectable descriptor without an adapter, and an adapter attached to a Coming-soon descriptor all fail at registry construction.

- [ ] **Step 2: Run the tests and observe the missing-module RED**

Run:

```bash
node --import tsx --test tests/backends.test.ts
```

Expected: FAIL because `src/backends.ts` and its exports do not exist.

- [ ] **Step 3: Implement the domain module with exhaustive literal unions**

Use these exact top-level contracts:

```ts
export const BACKEND_IDS = ["openrouter", "codex", "anthropic"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];
export type BackendMaturity = "stable" | "preview" | "coming-soon";
export type BillingRealm =
  | "openrouter-payg"
  | "chatgpt-subscription-provider-managed-overage"
  | "chatgpt-account-provider-managed-limits"
  | "none";

export interface RouteIdentityV1 {
  version: 1;
  backendId: BackendId;
  accountFingerprint: string;
  billingRealm: BillingRealm;
  requestedModelId: string;
  canonicalModelId: string | null;
  resolutionState: "legacy-unverified" | "resolved";
}

export interface ProviderHealth {
  credential: "valid" | "rejected" | "expired" | "login-required" | "unknown" | "not-applicable";
  connectivity: "connected" | "offline" | "unknown";
  spend: "available" | "limit-reached" | "unknown";
  runtime: "ready" | "missing" | "incompatible" | "policy-unavailable" | "not-applicable";
  observedAt: number;
  generation: number;
}

export type ProviderHeadline =
  | "ready"
  | "login-required"
  | "auth-rejected"
  | "credential-expired"
  | "offline"
  | "limit-reached"
  | "runtime-missing"
  | "incompatible-runtime"
  | "policy-unavailable"
  | "unknown";

export interface BackendDescriptor {
  id: BackendId;
  displayName: string;
  maturity: BackendMaturity;
  connectable: boolean;
  kind: "raw-model" | "managed-agent";
  credentialOwner: "orcode-keychain" | "provider-runtime" | "none";
  billingRealmKind: "api-payg" | "provider-managed" | "none";
  capabilities: {
    models: boolean;
    tools: boolean;
    reasoning: boolean;
  };
}

export interface BackendAdapter {
  readonly backendId: BackendId;
  inspect(request: { generation: number; deadlineAt: number; signal: AbortSignal }): Promise<ProviderInspection>;
  connect(request: { candidate: unknown; generation: number; signal: AbortSignal }): Promise<ProviderCandidate>;
  listModels(request: { candidateId?: string; signal: AbortSignal }): Promise<readonly BackendModelDescriptor[]>;
  activate(request: { candidateId: string; model: BackendModelDescriptor; signal: AbortSignal }): Promise<CandidateProviderState>;
  reconnect(request: { generation: number; deadlineAt: number; signal: AbortSignal }): Promise<ProviderInspection>;
  logout(request: { signal: AbortSignal }): Promise<void>;
  discardCandidate(candidateId: string): Promise<void>;
}

export interface BackendModelDescriptor {
  backendId: BackendId;
  requestedModelId: string;
  canonicalModelId: string;
  displayName: string;
  capabilities: { textInput: boolean; textOutput: boolean; tools: boolean; reasoning: boolean };
}

export interface ProviderInspection {
  backendId: BackendId;
  connectionId: string;
  health: ProviderHealth;
  headline: ProviderHeadline;
  accountFingerprint: string | null;
  billingRealm: BillingRealm;
  routeEligible: boolean;
  retryable: boolean;
  explanationCode: string;
}

export interface ProviderCandidate {
  candidateId: string;
  backendId: BackendId;
  connectionId: string;
  accountFingerprint: string | null;
  billingRealm: BillingRealm;
  health: ProviderHealth;
}

export interface CandidateProviderState {
  candidateId: string;
  backendId: BackendId;
  connectionId: string;
  accountFingerprint: string;
  billingRealm: BillingRealm;
  route: RouteIdentityV1;
}
```

Keep candidate payloads opaque and in-memory: events and persisted state carry only `candidateId`, safe route fields, and normalized status. `BackendRegistry.entries()` returns descriptors in insertion order; `adapter(id)` fails with `ProviderComingSoonError` for known non-connectable entries and a separate unknown-backend error for unknown IDs.

- [ ] **Step 4: Run domain and source type checks**

Run:

```bash
node --import tsx --test tests/backends.test.ts
npx tsc -p tsconfig.json --noEmit
```

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the provider-domain boundary**

```bash
git add src/backends.ts tests/backends.test.ts
git commit -m "feat: define provider backend contracts"
```

---

### Task 2: Versioned Provider State and Source-Aware Legacy Migration

**Files:**
- Create: `src/provider-state.ts`
- Create: `tests/provider-state.test.ts`
- Modify: `src/config.ts:92-176,176-285,333-395,626-660`
- Modify: `src/types.ts:26-41,102-121`
- Modify: `src/session.ts` at session parsing/open/save preference boundaries
- Modify: `tests/config.test.ts`
- Modify: `tests/session.test.ts`
- Modify: `tests/app-home-migration.test.ts`

**Interfaces:**
- Consumes: Task 1 `BackendId`, `BillingRealm`, `ProviderHealth`, `RouteIdentityV1`; existing `OrcodeConfigWithBudget`, `SessionData`, `saveConfig`, and `PrivateStore` protection.
- Produces: `ProviderSetupState`, `ProviderSetupStateV1`, `ProviderConnectionStateV1`, `ProviderStateIssue`, `validateProviderSetupState`, `createNeverConfiguredProviderState`, `migrateLegacyOpenRouterState`, `mapLegacyOpenRouterModel`, `projectLegacyModelRoutes`, and `ProviderStateStore`.

- [ ] **Step 1: Write RED tests for state validation and migration**

Pin these behaviors in `tests/provider-state.test.ts` and extend config/session migration tests:

```ts
test("a missing nested state in an existing config migrates OpenRouter without network or key reads", () => {
  const result = migrateLegacyOpenRouterState({
    mainModel: "openai/gpt-main",
    fallbackModels: ["anthropic/claude-fallback"],
    compressorModel: "qwen/compressor",
    transcriptionModel: "mistral/voice",
    panelModels: ["google/judge"],
    reasoningByModel: { "openai/gpt-main": { mode: "effort", effort: "high" } },
  }, { connectionId: "legacy-csprng-id" });

  assert.equal(result.lifecycle, "migrated");
  assert.equal(result.connections[0]?.backendId, "openrouter");
  assert.equal(result.connections[0]?.credentialSlot, "legacy:inference");
  assert.equal(result.defaultRoute?.requestedModelId, "openai/gpt-main");
  assert.equal(result.defaultRoute?.canonicalModelId, null);
  assert.equal(result.defaultRoute?.resolutionState, "legacy-unverified");
  assert.equal(result.cross.enabled, false);
});

test("legacy model projection preserves every role without slash parsing", () => {
  const projected = projectLegacyModelRoutes(legacyConfigFixture(), legacyConnectionFixture());
  assert.deepEqual(projected.fallbacks.map((route) => route.requestedModelId), ["vendor/a/b"]);
  assert.equal(projected.compressor.requestedModelId, "vendor/compressor");
  assert.equal(projected.transcription.requestedModelId, "vendor/audio");
  assert.deepEqual(projected.panel.map((route) => route.requestedModelId), ["vendor/judge"]);
  assert.equal(projected.reasoning["vendor/a/b"]?.requestedModelId, "vendor/a/b");
});

test("future and corrupt provider state remain distinct and cannot be saved over", async () => {
  const future = validateProviderSetupState({ schemaVersion: 99 });
  const corrupt = validateProviderSetupState({ schemaVersion: 1, connections: "wrong" });
  assert.deepEqual(future, { kind: "future-version", version: 99 });
  assert.deepEqual(corrupt, { kind: "corrupt" });
  await assert.rejects(saveConfig({ ...DEFAULT_CONFIG, providerSetup: future }, path), /future-version/);
  await assert.rejects(saveConfig({ ...DEFAULT_CONFIG, providerSetup: corrupt }, path), /corrupt/);
});
```

Add file-backed assertions that:

- `loadConfigDetailed` distinguishes an absent file (`never-configured`) from an existing legacy config (`migrated`);
- migration uses an injected `randomUUID` and performs zero credential/network calls;
- nested `schemaVersion: 99` survives byte-for-byte after unrelated `/budget`-style save refusal;
- repeated migration is state-stable and never rewrites the legacy keychain account;
- `config.provider` and every existing model preference remain byte-for-byte unchanged;
- a legacy `SessionData.model` derives an in-memory OpenRouter `route` with `resolutionState: "legacy-unverified"`, and a normal later session save persists that optional route without changing turns/costs.

- [ ] **Step 2: Run the migration selection and capture the RED**

Run:

```bash
node --import tsx --test tests/provider-state.test.ts tests/config.test.ts tests/session.test.ts tests/app-home-migration.test.ts
```

Expected: FAIL because the nested schema, source-aware migration, and route projection do not exist.

- [ ] **Step 3: Implement the exact nested schema**

Use these persisted/derived unions:

```ts
export const PROVIDER_SETUP_SCHEMA_VERSION = 1 as const;

export interface ProviderConnectionStateV1 {
  id: string;
  backendId: BackendId;
  enabled: boolean;
  maturity: "stable" | "preview";
  credentialSlot: string;
  accountFingerprint: string;
  accountFingerprintState: "provisional" | "verified";
  billingRealm: BillingRealm;
  lastHealth: ProviderHealth | null;
}

export interface ProviderSetupStateV1 {
  schemaVersion: 1;
  revision: number;
  lifecycle: "never-configured" | "cancelled" | "migrated" | "configured";
  connections: ProviderConnectionStateV1[];
  defaultRoute: RouteIdentityV1 | null;
  cross: {
    enabled: false;
    preferredLead: RouteIdentityV1 | null;
    preferredChallenger: RouteIdentityV1 | null;
  };
}

export type ProviderStateIssue =
  | { kind: "corrupt" }
  | { kind: "future-version"; version: number };
export type ProviderSetupState = ProviderSetupStateV1 | ProviderStateIssue;
```

`DEFAULT_CONFIG.providerSetup` is `createNeverConfiguredProviderState()`. Do **not** merge that default over a missing nested field before deciding whether an existing file is legacy. In `loadConfigDetailed`, parse the raw object first:

```ts
const providerSetup = "providerSetup" in parsed
  ? validateProviderSetupState(parsed.providerSetup)
  : migrateLegacyOpenRouterState(parsed, { connectionId: randomUUID() });
return {
  config: validateConfig({ ...DEFAULT_CONFIG, ...parsed, providerSetup }),
  warning: null,
  source: "file",
};
```

An absent config file still returns `createNeverConfiguredProviderState()`. `saveConfig` and every config-mutating command must reject `corrupt`/`future-version`; never serialize those derived sentinels as a replacement for the unknown bytes. Update `migrateAppHome(...normalizeConfig)` to use the same legacy source-aware path without network/credential access.

For the migrated connection only, set `accountFingerprint` to the display-safe provisional value `acct_legacy_<connectionId>` and `accountFingerprintState: "provisional"`. This is the same injected CSPRNG connection ID, never a hash/read of the legacy key. The first authenticated OpenRouter inspection must replace the provisional fingerprint atomically before the route becomes runnable; a mismatch opens repair rather than rebinding silently.

Add `route?: RouteIdentityV1` to `SessionData` as optional. `SessionStore` derives it only when a legacy model exists and the active migrated OpenRouter connection is supplied; it must not rewrite a chat merely by reading it.

Historical chats are migrated **lazily and deterministically on each open/list/use boundary**, not by an eager all-chat rewrite at startup. Extend the session tests with at least two separate legacy chat files: opening either derives the same migrated OpenRouter connection and exact role/model mapping, opening one does not mutate the other, the first ordinary save persists only that chat's optional route, and a second startup/open is byte-stable with no preference loss.

- [ ] **Step 4: Run migration, session, app-home, and both type checks**

Run:

```bash
node --import tsx --test tests/provider-state.test.ts tests/config.test.ts tests/session.test.ts tests/app-home-migration.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
```

Expected: all selected tests PASS; both TypeScript commands exit 0.

- [ ] **Step 5: Commit provider-state migration**

```bash
git add src/provider-state.ts src/config.ts src/types.ts src/session.ts tests/provider-state.test.ts tests/config.test.ts tests/session.test.ts tests/app-home-migration.test.ts
git commit -m "feat: migrate versioned provider state"
```

---

### Task 3: One Secret Pipeline and Versioned Keychain Slots

**Files:**
- Modify: `src/credentials.ts:1-190`
- Modify: `src/tui.ts:631-639,1127-1160,1597-1628`
- Modify: `src/commands.ts:405-520,618-940`
- Modify: `src/cli.ts:2111-2314`
- Modify: `tests/credentials.test.ts`
- Modify: `tests/tui.test.ts`
- Modify: `tests/commands.test.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Consumes: existing fixed `CredentialStoreLike.get/set/delete/has`; existing keychain service `de.routercode.openrouter`; `TerminalUi.readSecret`.
- Produces: `normalizeProviderSecret`, `CredentialSlotRef`, `VersionedCredentialStoreLike`, and production methods `reserveSlot`, `writeSlot`, `readSlot`, `deleteSlot`, `getOrCreateAccountHmacKey`. Existing fixed-slot methods remain source-compatible.

- [ ] **Step 1: Add RED tests for normalization before side effects**

Use a deterministic synthetic key assembled in the test and assert the same function is used from plain, fullscreen, setup, `/key replace`, and management paths:

```ts
test("provider secret normalization strips only outer Unicode whitespace", () => {
  const body = `${["sk", "or", "v1"].join("-")}-${"a".repeat(48)}`;
  assert.equal(normalizeProviderSecret(`\u00a0\r\n${body}\r\n\u2003`), body);
});

for (const invalid of [
  `prefix ${"a".repeat(30)}`,
  `prefix\t${"a".repeat(30)}`,
  `prefix\0${"a".repeat(30)}`,
  `prefix\u001b[31m${"a".repeat(30)}`,
  `prefix\u0007${"a".repeat(30)}`,
]) {
  test(`provider secret rejects internal control fixture ${JSON.stringify(invalid.slice(0, 8))}`, () => {
    assert.throws(() => normalizeProviderSecret(invalid), /ungültig|Steuer|Leerzeichen/i);
  });
}

test("locally rejected setup input makes zero network and keychain calls", async () => {
  const calls: string[] = [];
  await assert.rejects(
    validateAndActivateInferenceKey(`bad\n${"x".repeat(30)}`, fixtureContext(calls)),
    /ungültig/i,
  );
  assert.deepEqual(calls, []);
});
```

Add a real `TerminalUi` test where bracketed paste inserts CRLF around one candidate, requires one later Enter, renders only mask characters, and hands the original bytes to `normalizeProviderSecret`. Add cancellation and error assertions that the private `#inputChars`/paste buffer no longer influence the next `readInput()`.

- [ ] **Step 2: Add RED tests for versioned slots and legacy compatibility**

Extend the fake keyring entry factory to key by service/account and assert:

```ts
const first = store.reserveSlot("inference");
const second = store.reserveSlot("inference");
assert.notEqual(first.id, second.id);
await store.writeSlot(first, keyA);
await store.writeSlot(second, keyB);
assert.equal(await store.readSlot(first), keyA);
assert.equal(await store.readSlot(second), keyB);
assert.equal(await store.get("inference"), legacyKey);
assert.equal(await store.deleteSlot(first), true);
assert.equal(await store.readSlot(first), null);
assert.equal(await store.get("inference"), legacyKey);
```

Also cover exact readback mismatch, candidate write failure, delete failure, invalid/forged slot IDs, error redaction, collision-free concurrent slot reservation, zero keychain calls from reservation alone, and one stable 32-byte `getOrCreateAccountHmacKey()` value under the fixed internal account `provider-account-hmac-v1`.

- [ ] **Step 3: Run both RED groups**

Run:

```bash
node --import tsx --test tests/credentials.test.ts tests/tui.test.ts tests/commands.test.ts tests/cli.test.ts
```

Expected: FAIL on missing normalization/slot APIs and the current TUI secret-path sanitization.

- [ ] **Step 4: Implement normalization and slot methods without changing the service name**

Use exact opaque references and reject arbitrary keychain account access:

```ts
export interface CredentialSlotRef {
  version: 1;
  kind: "inference" | "management";
  id: string;
}

export interface VersionedCredentialStoreLike extends CredentialStoreLike {
  reserveSlot(kind: CredentialSlotRef["kind"]): CredentialSlotRef;
  writeSlot(slot: CredentialSlotRef, secret: string): Promise<void>;
  readSlot(slot: CredentialSlotRef): Promise<string | null>;
  deleteSlot(slot: CredentialSlotRef): Promise<boolean>;
  getOrCreateAccountHmacKey(): Promise<Uint8Array>;
}

export function normalizeProviderSecret(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || /\s/u.test(normalized) || /[\0-\x1f\x7f\u001b]/u.test(normalized)) {
    throw new Error("Der Provider-Key ist ungültig oder enthält Leerzeichen/Steuerzeichen.");
  }
  return normalized;
}
```

`reserveSlot()` creates an in-memory ID with `randomUUID()` and no keychain side effect. Map only a validated `v1:<kind>:<uuid>` to keychain account `provider-slot:<id>`. `writeSlot()` writes and performs exact readback before returning. Never enumerate arbitrary keychain accounts. Keep legacy `inference-api-key` and `management-api-key` exactly as they are. The common normalizer imposes no provider prefix or minimum length; any documented provider-shape check belongs in that adapter, while `/key` remains OpenRouter's authentication authority.

In secret mode, `TerminalUi` must keep paste bytes distinguishable until common validation; do not run the normal chat-paste tab/control rewriting before `normalizeProviderSecret`. Still render only masked length and clear the buffer on resolve/reject/cancel. All activation methods normalize before invoking `OpenRouterService` or `CredentialStore`.

- [ ] **Step 5: Run credential/input regression gates**

Run:

```bash
node --import tsx --test tests/credentials.test.ts tests/tui.test.ts tests/commands.test.ts tests/cli.test.ts tests/redaction.test.ts tests/secrets.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
```

Expected: all tests PASS and both type checks exit 0.

- [ ] **Step 6: Commit the secret and slot boundary**

```bash
git add src/credentials.ts src/tui.ts src/commands.ts src/cli.ts tests/credentials.test.ts tests/tui.test.ts tests/commands.test.ts tests/cli.test.ts
git commit -m "fix: normalize provider secrets before activation"
```

---

### Task 4: OpenRouter Backend Adapter and Structured Health

**Files:**
- Create: `src/openrouter-backend.ts`
- Create: `tests/openrouter-backend.test.ts`
- Modify: `src/openrouter.ts:31-82,640-1025,1122-1220,1614-1641`
- Modify: `src/types.ts:42-54`
- Modify: `tests/openrouter.test.ts`

**Interfaces:**
- Consumes: Task 1 adapter/descriptor/health contracts; Task 3 `VersionedCredentialStoreLike`; existing `OpenRouterService` request/reconnect/model methods and the existing exported `isMainModelCandidate` role predicate.
- Produces: `OPENROUTER_DESCRIPTOR`, `ANTHROPIC_COMING_SOON_DESCRIPTOR`, `OpenRouterBackendAdapter`, `OpenRouterInspection`, and `openRouterAccountFingerprint`.

- [ ] **Step 1: Write the exact OpenRouter health matrix RED**

Create a table whose expected result asserts every independent dimension and whether `/credits` was called:

```ts
const cases = [
  { name: "valid", keyStatus: 200, expected: ["valid", "connected", "available"] },
  { name: "rejected", keyStatus: 401, expected: ["rejected", "connected", "unknown"] },
  { name: "ambiguous forbidden", keyStatus: 403, expected: ["unknown", "connected", "unknown"] },
  { name: "rate limited", keyStatus: 429, expected: ["unknown", "connected", "unknown"] },
  { name: "provider failure", keyStatus: 503, expected: ["unknown", "connected", "unknown"] },
] as const;

for (const fixture of cases) {
  test(`OpenRouter inspection classifies ${fixture.name}`, async () => {
    const result = await inspectFixture(fixture);
    assert.deepEqual(
      [result.health.credential, result.health.connectivity, result.health.spend],
      fixture.expected,
    );
    assert.equal(result.modelRequests, 0);
  });
}
```

Add separate tests for DNS, TLS, abort, timeout, past/future/missing `expires_at`, missing numeric usage, `limit_remaining: 0`, management-capable inference key, normal inference plus saved management key, and no management capability. Assert `/credits` 401/403/429/5xx/DNS changes only spend to `unknown` while credential remains `valid` and connectivity reflects the actual `/key` result.

Model tests must reuse `isMainModelCandidate`: no-text-input, no-text-output, and no-tools entries never appear in the setup main-model list; exact `openrouter/auto` keeps only the already-approved main-only exception and no role predicate is duplicated in the adapter.

Pin management precedence separately: a saved management key wins and suppresses `OPENROUTER_MANAGEMENT_KEY`; with no saved management key, a non-empty environment management key may be inspected automatically for that process and is never persisted. Unknown `is_management_key` must skip `/credits` rather than guessing.

Assert that a valid/connected inference key with no authoritative credit source has `spend: "unknown"`, headline `ready`, `routeEligible: true`, and a visible `Guthaben unbekannt` qualifier. Known zero remaining spend instead has `limit-reached` and is not runnable.

Add identity tests using documented `/key.data.creator_user_id`:

```ts
const left = openRouterAccountFingerprint(hmacKey, "user_documented_a");
const again = openRouterAccountFingerprint(hmacKey, "user_documented_a");
const right = openRouterAccountFingerprint(hmacKey, "user_documented_b");
assert.equal(left, again);
assert.notEqual(left, right);
assert.doesNotMatch(JSON.stringify(result), /user_documented_a/);
```

If `creator_user_id` is absent/null, inspection may authenticate the key but must return `accountFingerprint: null` and `routeEligible: false`; it must not hash the raw key or label.

- [ ] **Step 2: Run the adapter and service RED**

Run:

```bash
node --import tsx --test tests/openrouter-backend.test.ts tests/openrouter.test.ts
```

Expected: FAIL because the adapter, account field, expiry state, and management degradation are missing.

- [ ] **Step 3: Make candidate and active inspection non-mutating by construction**

Extend `KeyInfo` with optional documented identity/usage fields rather than coercing missing values to zero:

```ts
export interface KeyInfo {
  creatorUserId?: string | null;
  // existing fields remain
  usage?: number;
  usageDaily?: number;
  usageWeekly?: number;
  usageMonthly?: number;
}
```

Add an `OpenRouterService.inspectKey` operation returning parsed metadata without mutating the active service for candidate scope. Keep `#recordResponse` scope-aware: `/credits` responses never mutate inference validity, and candidate calls never mutate active state. The adapter derives `ProviderHealth`; it does not expose raw response text.

Use this fingerprint formula exactly so Slice 2 can share the namespace without collisions:

```ts
createHmac("sha256", hmacKey)
  .update("orcode-provider-account/v1\0openrouter\0", "utf8")
  .update(creatorUserId, "utf8")
  .digest("base64url");
```

Prefix the stored display-safe value with `acct_or_`. Never persist/log `creator_user_id` itself.

`ANTHROPIC_COMING_SOON_DESCRIPTOR` is data only. Do not instantiate an adapter, credential store, process runner, or fetcher for it.

- [ ] **Step 4: Run OpenRouter, privacy, and types**

Run:

```bash
node --import tsx --test tests/openrouter-backend.test.ts tests/openrouter.test.ts tests/credentials.test.ts tests/redaction.test.ts tests/secrets.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
```

Expected: all tests PASS; no fixture contains a complete credential or raw creator user ID.

- [ ] **Step 5: Commit the Slice-1 adapter**

```bash
git add src/openrouter-backend.ts src/openrouter.ts src/types.ts tests/openrouter-backend.test.ts tests/openrouter.test.ts
git commit -m "feat: inspect OpenRouter provider health"
```

---

### Task 5: Crash-Recoverable Credential and Route Activation

**Files:**
- Create: `src/provider-activation.ts`
- Create: `tests/provider-activation.test.ts`
- Modify: `src/provider-state.ts`
- Modify: `src/config.ts`
- Modify: `src/credentials.ts`
- Modify: `src/private-store.ts`
- Modify: `tests/private-store.test.ts`
- Modify: `tests/private-store-identity-races.test.ts`

**Interfaces:**
- Consumes: `ProviderStateStore`, `ProviderSetupStateV1`, `RouteIdentityV1`, `OpenRouterBackendAdapter`, `VersionedCredentialStoreLike`, `PrivateStore`, `loadConfigDetailed`, and `saveConfig`.
- Produces: `ProviderActivationCoordinator`, `ProviderActivationJournalV1`, `ProviderActivationResult`, `StaleProviderGenerationError`, `recoverProviderActivation`, plus the narrowly scoped `PrivateStore.createDirectoryExclusive()` primitive.

- [ ] **Step 1: Write fault-injection REDs at every durable boundary**

The test fixture must expose hooks named exactly after the transaction phases:

```ts
const boundaries = [
  "candidate-validated",
  "journal-written",
  "slot-written",
  "slot-readback",
  "candidate-revalidated",
  "models-loaded",
  "model-selected",
  "config-written",
  "config-readback",
  "runtime-activated",
  "old-slot-cleaned",
] as const;

for (const boundary of boundaries) {
  test(`activation crash after ${boundary} recovers one complete tuple`, async () => {
    const fixture = await activationFixture({ crashAfter: boundary });
    await assert.rejects(fixture.activate());
    const recovered = await fixture.restartAndRecover();
    assert.ok(
      deepEqual(recovered, fixture.oldTuple) || deepEqual(recovered, fixture.newTuple),
      `mixed tuple after ${boundary}: ${JSON.stringify(recovered)}`,
    );
    assert.equal(recovered.connection?.credentialSlot === recovered.slot?.id, true);
  });
}
```

Add tests for:

- two parallel activations with the same expected revision: one commits, one throws `StaleProviderGenerationError` and cannot overwrite;
- an affected adapter with an active run rejects activation/default replacement before slot or config mutation; after an explicit drain the same intent may proceed;
- config write/readback failure restores the old pointer and deletes only the unreferenced candidate slot;
- candidate cleanup failure surfaces a redacted warning but never deletes the active or foreign slot;
- restart with `config.providerSetup` pointing at the new slot retains both slots until normal OpenRouter inspection verifies the new candidate, then removes the old slot;
- process-only approval activates an ephemeral route/service but writes no journal, slot, config, or persisted route;
- declining process-only after keychain failure leaves active runtime, config bytes, and keychain bytes unchanged;
- the legacy fixed inference slot remains readable and unchanged through migration **and after** an explicit successful persisted replacement; Slice 1 never automatically deletes a version-0 legacy slot.
- a symlinked/swapped lease root or ancestor fails closed without creating, protecting, reading, or deleting anything outside app home; parallel `createDirectoryExclusive()` calls have exactly one winner.

- [ ] **Step 2: Run the activation RED**

Run:

```bash
node --import tsx --test tests/provider-activation.test.ts tests/provider-state.test.ts tests/credentials.test.ts tests/config.test.ts
```

Expected: FAIL because no journal/revision transaction exists.

- [ ] **Step 3: Implement the no-secret journal and lease**

Persist only this shape under protected app home at `provider-activation/<transactionId>/manifest.json` using `PrivateStore.writeTextAtomic`; accept only a freshly generated or strictly UUID-validated `transactionId` before path construction:

```ts
export interface ProviderActivationJournalV1 {
  version: 1;
  transactionId: string;
  expectedRevision: number;
  phase: "prepared" | "credential-staged" | "config-committed";
  backendId: "openrouter";
  candidateSlot: CredentialSlotRef;
  previousSlot: CredentialSlotRef | { version: 0; kind: "inference"; id: "legacy:inference" } | null;
  candidateConnectionId: string;
  candidateRoute: RouteIdentityV1;
}
```

The manifest contains no key, account source field, model response, or credential path. Serialize provider mutation with a bounded `provider-setup.lock/` directory created through a new `PrivateStore.createDirectoryExclusive()` primitive. That primitive must bind the verified root/ancestor identities, use one exclusive `mkdir`, recheck the created inode before returning, roll back only the bound directory on protection failure, and never follow a symlink. Write `owner.json` inside it with owner UUID/time, reject a live lease, and recover only a stale lease after revalidating the exact directory identity. Release through the existing root-bound `removeTree`; do not use raw `open("wx")`, `unlink`, or recursive `rm` on an unresolved path.

Activation order is fixed:

1. normalize and validate in memory;
2. obtain the local HMAC key and derive the account fingerprint;
3. list compatible main models and accept one explicit selected canonical model;
4. acquire lease and re-read config;
5. compare `expectedRevision`;
6. reserve the candidate slot ID in memory without touching the keychain;
7. write the prepared journal containing that exact reserved slot reference;
8. write/read back the secret through `writeSlot(candidateSlot, secret)`;
9. revalidate that exact slot and same fingerprint;
10. update journal to `credential-staged`;
11. re-read current config, merge **only** the new `providerSetup`, atomically save/readback;
12. update journal to `config-committed`;
13. bind the already-validated key/route to the active `OpenRouterService`;
14. delete the old slot only when it is an unreferenced **versioned v1** slot; a version-0 legacy slot is compatibility-exempt;
15. remove the transaction tree and release the lease.

Recovery compares journal, current config pointer, and exact slot readback. If config still references the old slot, delete only the unreferenced versioned candidate slot. If config references the candidate, retain it and finish cleanup of an old **versioned** slot only after the next normal provider inspection verifies it. Version-0 legacy slots are never auto-cleaned. Corrupt/future config performs no cleanup or mutation.

- [ ] **Step 4: Run activation, private-store, and compiler gates**

Run:

```bash
node --import tsx --test tests/provider-activation.test.ts tests/provider-state.test.ts tests/credentials.test.ts tests/config.test.ts tests/private-store.test.ts tests/private-store-identity-races.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
```

Expected: all tests PASS; the existing Windows-only PrivateStore integration remains an honest platform skip on non-Windows hosts.

- [ ] **Step 5: Commit the activation transaction**

```bash
git add src/provider-activation.ts src/provider-state.ts src/config.ts src/credentials.ts src/private-store.ts tests/provider-activation.test.ts tests/provider-state.test.ts tests/credentials.test.ts tests/config.test.ts tests/private-store.test.ts tests/private-store-identity-races.test.ts
git commit -m "feat: activate provider routes transactionally"
```

---

### Task 6: Generation-Safe Setup Orchestrator and Startup Deadlines

**Files:**
- Create: `src/setup.ts`
- Create: `tests/setup.test.ts`
- Modify: `src/backends.ts`
- Modify: `src/provider-state.ts`

**Interfaces:**
- Consumes: `BackendRegistry`, `BackendAdapter`, `ProviderStateStore`, `ProviderActivationCoordinator`, and an injected clock.
- Produces: `SetupClock`, `SetupEvent`, `StartupSetupMode`, `StartupSetupResult`, `SetupOrchestrator`, `ProviderSetupRequiredError`, and `ProviderInspectionTimeoutError`.

- [ ] **Step 1: Write deterministic RED tests for inspection policy**

Build fake adapters, an explicit fake scheduler, and an event recorder. Pin these cases:

```ts
test("startup inspects only enabled runnable backends and never connects or lists models", async () => {
  const fixture = setupFixture({
    state: configuredOpenRouterState(),
    adapters: { openrouter: fakeAdapter({ inspect: healthyInspection() }) },
  });
  const result = await fixture.orchestrator.inspectStartup();
  assert.equal(result.mode, "ready");
  assert.deepEqual(fixture.calls, ["openrouter.inspect"]);
  assert.equal(result.crossEnabled, false);
});

test("late results from an older generation cannot overwrite a reconnect", async () => {
  const fixture = setupFixture({ deferredInspections: true });
  const oldRun = fixture.orchestrator.inspectStartup();
  const newRun = fixture.orchestrator.reconnect("openrouter");
  fixture.resolveInspection(2, healthyInspection());
  fixture.resolveInspection(1, rejectedInspection());
  await Promise.all([oldRun, newRun]);
  assert.equal(fixture.state().connections[0]?.lastHealth?.generation, 2);
  assert.equal(fixture.state().connections[0]?.lastHealth?.credential, "valid");
});
```

Also assert:

- a healthy default route is silent and returns `ready`;
- a healthy default plus a degraded secondary returns `ready-with-warning` without switching routes;
- an unhealthy default with another ready route returns `route-choice-required`, never auto-switches, and performs no config write;
- no ready route returns `setup-required`;
- only `credential: "rejected"` yields an auth-replacement action; offline/timeout/403/429/5xx stay retryable;
- default deadlines are exactly 5,000 ms per provider and 8,000 ms total;
- requested provider/whole deadlines clamp to 15,000/30,000 ms;
- provider timeout aborts only that inspection, while whole-startup timeout aborts all outstanding inspections;
- a user cancellation stores lifecycle `cancelled`, keeps Cross false, and leaves the process usable;
- `ensureRunnableRoute()` returns the exact current route only for `ready`, otherwise throws a typed `ProviderSetupRequiredError` without mutation;
- `inspectStartup()` creates no candidate, performs no keychain write, calls no `connect`, `listModels`, `activate`, model request, chat turn, or run event.
- after a healthy migrated route, `resolveLegacyDefaultRoute()` performs one compatible-model metadata lookup, silently commits the exact matching canonical ID, and remains byte-stable thereafter;
- a missing/incompatible legacy requested model returns `route-choice-required` and cannot guess or silently replace it.

- [ ] **Step 2: Run the orchestrator RED**

Run:

```bash
node --import tsx --test tests/setup.test.ts tests/backends.test.ts tests/provider-state.test.ts
```

Expected: FAIL because the state machine, generation discard, and fake-clock deadlines do not exist.

- [ ] **Step 3: Implement the surface-neutral state machine**

Use these public contracts:

```ts
export interface SetupClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type StartupSetupMode =
  | "ready"
  | "ready-with-warning"
  | "route-choice-required"
  | "setup-required";

export type SetupEvent =
  | { version: 1; type: "inspection-start"; backendId: BackendId; generation: number }
  | { version: 1; type: "inspection-end"; backendId: BackendId; maturity: BackendMaturity; generation: number; durationMs: number; health: ProviderHealth; headline: ProviderHeadline; accountFingerprint: string | null; billingRealm: BillingRealm }
  | { version: 1; type: "inspection-discarded"; backendId: BackendId; generation: number; reason: "stale-generation" }
  | { version: 1; type: "candidate-activation"; backendId: BackendId; generation: number; connectionId: string; route: RouteIdentityV1 }
  | { version: 1; type: "setup-required"; generation: number }
  | { version: 1; type: "route-choice-required"; generation: number; routeIds: readonly string[] }
  | { version: 1; type: "warning"; generation: number; code: string; message: string }
  | { version: 1; type: "terminal-failure"; backendId: BackendId | null; generation: number; code: string; retryable: boolean; message: string };

export interface StartupSetupResult {
  mode: StartupSetupMode;
  generation: number;
  defaultRoute: RouteIdentityV1 | null;
  readyRoutes: readonly RouteIdentityV1[];
  warnings: readonly string[];
  crossEnabled: false;
}
```

`SetupOrchestrator` owns one monotonically increasing in-memory generation. Each inspection captures it; completion compares it before emitting or persisting. Wrap adapter inspection with the injected clock and an `AbortController`, and clear every timer in `finally`. Persist normalized health only when the provider-state revision still matches; never persist timeouts as credential rejection.

Events contain only the normalized fields above. Messages are built from fixed local templates, never provider response text. Candidate events may carry safe route identity but never candidate input, a secret, raw account ID, credential path, provider body, login URL, or device code.

Add a separate `resolveLegacyDefaultRoute()` transition after successful health inspection. It may call model-catalog metadata only for a valid `legacy-unverified` default route. If the exact requested model is compatible, atomically store its canonical ID without prompting; if it is absent/incompatible, return `route-choice-required` and require an explicit replacement. `inspectStartup()` itself still never calls `listModels`, `connect`, or `activate`.

- [ ] **Step 4: Run focused lifecycle, type, and cancellation gates**

Run:

```bash
node --import tsx --test tests/setup.test.ts tests/backends.test.ts tests/provider-state.test.ts tests/openrouter-backend.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
```

Expected: all tests PASS; timer handles are empty after every test.

- [ ] **Step 5: Commit the orchestrator**

```bash
git add src/setup.ts src/backends.ts src/provider-state.ts tests/setup.test.ts tests/backends.test.ts tests/provider-state.test.ts
git commit -m "feat: orchestrate bounded provider startup"
```

---

### Task 7: One Setup Hub for Plain and Fullscreen Modes

**Files:**
- Create: `src/setup-ui.ts`
- Create: `tests/setup-ui.test.ts`
- Modify: `src/tui.ts`
- Modify: `src/cli.ts`
- Modify: `tests/tui.test.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `SetupOrchestrator`, `ProviderActivationCoordinator`, `BackendRegistry`, existing `TerminalUi.pickChoice/readSecret/pickModel/confirmAction`, and `@inquirer/prompts` select/password/confirm.
- Produces: `SetupSurface`, `SetupHubEntry`, `SetupHubResult`, `runSetupHub`, `createPlainSetupSurface`, and `createTuiSetupSurface`.

- [ ] **Step 1: Write common controller RED tests**

Use a scripted `SetupSurface` that records prompts and returns one choice at a time:

```ts
export interface SetupSurface {
  chooseHub(entries: readonly SetupHubEntry[]): Promise<string | null>;
  readSecret(request: { backendId: BackendId; message: string }): Promise<string | null>;
  chooseModel(request: { backendId: BackendId; models: readonly BackendModelDescriptor[] }): Promise<string | null>;
  confirm(request: { id: string; message: string; defaultValue: boolean }): Promise<boolean>;
  present(event: SetupEvent | { version: 1; type: "notice"; message: string }): void;
}
```

Pin the controller behavior:

- one prompt is active at a time; the loop always renders the latest provider state and generation;
- OpenRouter connect is exactly secret -> validate -> compatible main models -> explicit model choice -> activation transaction;
- successful retry clears the previous visible error and refreshes the current-state header;
- with a rejected saved key, an environment candidate is only mentioned and validated after the user explicitly selects it;
- with no saved key, a non-empty environment candidate is automatically inspected and may activate process-only; it is never persisted, and any later save still needs a separate explicit confirmation;
- selecting Anthropic shows a Coming-soon explanation and performs zero credential, executable, network, model, config, or process calls;
- cancelling before activation at provider, secret, model, or persistence returns `{ kind: "cancelled", mode: "setup-required" }` without exiting the chat;
- after activation has committed, Escape/cancel on the optional Cross screen is exactly `Later`: it returns `{ kind: "ready" }`, keeps the usable route/configured lifecycle, and leaves Cross off;
- the final Cross screen offers `Later` and `Prepare roles`; both keep `cross.enabled === false`;
- `Prepare roles` requires two fully resolved routes with **different canonical model IDs** (same family/account is allowed), stores preferences without starting a model call or collaboration, and rejects two realms that merely expose the same canonical model;
- no new provider can silently replace the default route; route selection is explicit.
- narrow and wide fullscreen snapshots contain exactly one current provider card, clear an older error after success, and show Anthropic as disabled `Coming soon`;
- keyboard and mouse selection of Anthropic both produce the same explanation and the same zero-side-effect call trace.

- [ ] **Step 2: Run the controller RED**

Run:

```bash
node --import tsx --test tests/setup-ui.test.ts tests/setup.test.ts tests/tui.test.ts tests/cli.test.ts
```

Expected: FAIL because the common hub and adapters do not exist.

- [ ] **Step 3: Implement adapters using existing primitives only**

`runSetupHub()` owns the flow and calls only `SetupSurface`; it must not import `TerminalUi`, Inquirer, stdin, or stdout. `createTuiSetupSurface(ui)` delegates to existing fullscreen choice/model/confirm behavior. `createPlainSetupSurface(io)` uses existing Inquirer `select`, `password`, and `confirm` with the same choices and cancellation semantics. Do not add multi-select or a second setup state machine.

In `src/tui.ts`, change secret-mode buffering only: retain raw pasted characters until `normalizeProviderSecret()` can reject embedded control/ANSI data; continue masking every character and clear the raw buffer in `finally`. Ordinary chat paste normalization must remain unchanged.

Keep provider-facing strings data-driven from the registry descriptor. The Anthropic item is visible but disabled for connection; its explanatory action returns without calling an adapter.

- [ ] **Step 4: Run setup UI, masking, and compiler gates**

Run:

```bash
node --import tsx --test tests/setup-ui.test.ts tests/setup.test.ts tests/tui.test.ts tests/credentials.test.ts tests/cli.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
```

Expected: all tests PASS; captured screen/output contains neither a complete secret nor the raw invalid input.

- [ ] **Step 5: Commit the common setup UI**

```bash
git add src/setup-ui.ts src/tui.ts src/cli.ts tests/setup-ui.test.ts tests/tui.test.ts tests/cli.test.ts
git commit -m "feat: add the provider setup hub"
```

---

### Task 8: Integrate Provider Setup at the CLI Startup Boundary

**Files:**
- Modify: `src/cli.ts:186-498,530-621,927-1010,2111-2314`
- Modify: `src/commands.ts:405-520`
- Modify: `tests/cli.test.ts`
- Modify: `tests/cli-entrypoint.test.ts`
- Modify: `tests/integration.test.ts`

**Interfaces:**
- Consumes: `initializeStartupStorage`, Tasks 1-7 provider runtime, `OrcodeAgent`, `runPlainLoop`, and `runDashboard`.
- Produces: exported injectable `runCli`, a typed non-interactive provider failure renderer, and one provider-runtime object shared by CLI, commands, and the agent run gate.

- [ ] **Step 1: Write bootstrap RED tests before moving production order**

Introduce an injected bootstrap entry point:

```ts
export interface CliBootstrapDeps {
  initializeStorage: typeof initializeStartupStorage;
  createProviderRuntime(input: ProviderRuntimeInput): Promise<ProviderRuntime>;
  createAgent(input: OrcodeAgentCreateInput): Promise<OrcodeAgent>;
  runPlain(input: PlainRunInput): Promise<void>;
  runDashboard(input: DashboardRunInput): Promise<void>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export async function runCli(argv: readonly string[], deps: CliBootstrapDeps = defaultCliBootstrapDeps): Promise<number>;
```

Tests must pin:

- `--help` and `--version` return before `initializeStorage`, keychain, provider runtime, executable discovery, model catalog, agent creation, and network;
- every ordinary interactive start runs storage migration/recovery first, then provider-state load/activation recovery, then bounded health inspection;
- no model catalog snapshot, agent model client, prompt dispatch, or run event happens before a ready route exists;
- a healthy saved default enters plain/fullscreen mode silently;
- a healthy secondary plus degraded default never auto-switches and opens route choice;
- rejected saved credential never automatically validates `OPENROUTER_API_KEY`; only explicit setup selection does;
- with no saved credential, a non-empty environment credential is automatically inspected process-only; a valid exact route may run without prompting, and the credential is never persisted implicitly;
- fullscreen `Escape` and plain setup cancellation enter chat/command mode with provider status `setup-required` and do not terminate;
- slash commands that need no model still work in `setup-required`;
- the next model input calls `ensureRunnableRoute()`, reopens setup if needed, and never queues the prompt before success;
- `-p` and `--json` are non-interactive even when `stdin.isTTY === true`: with a valid process-only environment key and exact compatible route they run without prompting; with no usable route they write a typed `provider-setup-required` error and return 1;
- provider timeout/offline returns a retryable setup state, not a key-replacement prompt;
- Cross remains off and setup inspection produces no chat/run artifacts.

Update only stale tests that expect an environment fallback **after a saved key exists or is rejected**. Preserve/add the no-saved-key automatic process-only path, including a non-interactive success case.

- [ ] **Step 2: Run the CLI ordering RED**

Run:

```bash
node --import tsx --test tests/cli.test.ts tests/cli-entrypoint.test.ts tests/integration.test.ts tests/setup.test.ts tests/setup-ui.test.ts
```

Expected: FAIL because `main()` is not injectable and startup still reaches key/model paths in the old order.

- [ ] **Step 3: Refactor startup around the provider runtime**

Keep argument parsing and the `--help`/`--version` returns at the top of `runCli`. After `initializeStartupStorage` succeeds:

1. construct registry, state store, versioned credential store, OpenRouter adapter, activation coordinator, and orchestrator;
2. recover any activation journal before reading an active route;
3. inspect enabled providers within the startup deadline;
4. resolve a healthy migrated `legacy-unverified` default through the explicit legacy-route transition (silent only for an exact compatible match);
5. enter the common setup hub only when the reducer requires it;
6. validate any `--model` preference against that exact ready route before mutating config/session preferences;
7. create/use model-dependent runtime only after `ensureRunnableRoute()` returns the exact structured route;
8. pass that same provider runtime into command contexts and both UI modes.

Remove the old automatic environment **replacement** after any saved key from `initializeDashboardKey()` and `promptForValidKey()`. Route precedence through the adapter: saved key first and exclusively; only when it is absent may `OPENROUTER_API_KEY` be inspected automatically as a process-only candidate. Preserve the old functions only as compatibility wrappers over that policy and explicit replacement intents. `OrcodeAgent.create()` may remain early if it is provably provider-inert; actual client/compressor creation and every prompt must remain behind the route gate.

For non-interactive failure, emit one stable structured record in JSON mode and one concise stderr line in prompt mode. Include only safe fields: error code, provider headline, retryability, and a `/provider setup` hint.

- [ ] **Step 4: Run CLI, session, privacy, and type gates**

Run:

```bash
node --import tsx --test tests/cli.test.ts tests/cli-entrypoint.test.ts tests/integration.test.ts tests/setup.test.ts tests/setup-ui.test.ts tests/session.test.ts tests/commands.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
```

Expected: all tests PASS; no non-interactive test records a prompt call.

- [ ] **Step 5: Commit the startup integration**

```bash
git add src/cli.ts src/commands.ts tests/cli.test.ts tests/cli-entrypoint.test.ts tests/integration.test.ts
git commit -m "feat: gate startup on provider readiness"
```

---

### Task 9: Provider Commands, Compatibility, and Generated Documentation

**Files:**
- Modify: `src/commands.ts:105-203,252-405,2145-2215`
- Modify: `src/command-catalog.ts:160-175`
- Modify: `src/cli.ts` dashboard slash-command pre-dispatch branches
- Modify: `src/setup-ui.ts`
- Modify: `README.md`
- Modify: `tests/commands.test.ts`
- Modify: `tests/commands-catalog.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/integration.test.ts`
- Modify: `scripts/render-command-docs.ts` only if needed for generated prose markers

**Interfaces:**
- Consumes: catalog `resolveSlashCommand`, provider runtime/controller, setup surfaces, and the shared activation transaction.
- Produces: `/provider setup|connect|enable|disable|disconnect|reconnect|status|models|logout` while preserving every legacy `/provider` behavior.

- [ ] **Step 1: Write command-compatibility RED tests**

Capture the current bare `/provider` output and legacy mutations as exact snapshots before changing dispatch. Then add tests that:

- bare `/provider` remains byte-identical;
- legacy `sort|allow|deny|only|ignore|fallback|clear` arguments and mutations remain exact;
- `setup` opens the common hub and `connect openrouter` enters the same controller path;
- `connect anthropic`, `enable anthropic`, and `models anthropic` return a typed Coming-soon explanation with zero keychain/network/process/config calls;
- `status` reports enabled/disabled, safe account fingerprint suffix, billing realm, headline, default marker, and Cross off without secret/account/provider-response data;
- `models openrouter` is unavailable until a usable route/candidate exists and never uses a rejected saved credential;
- `reconnect openrouter` reuses the bounded generation-aware inspection and cannot let a stale result win;
- disabling/disconnecting a non-default connection is explicit and non-destructive;
- disabling the last runnable/default connection asks exactly one approval question, decline is an exact no-op, accept clears the default route and leaves chat `setup-required` rather than exiting;
- `logout` asks exactly one confirmation, decline is byte-identical, and accept removes only the selected connection's current versioned slot after state commit/readback; it never deletes the legacy or another connection's slot;
- activation, default replacement, disable, disconnect, and logout all fail before mutation while that adapter has an active run, then succeed only after the shared idle/drain boundary completes;
- `/key replace` and `/key save` delegate to `ProviderActivationCoordinator` and cannot bypass readback, revalidation, model selection, or the old-or-new transaction;
- dashboard alias/canonical pre-dispatch uses the catalog resolver and does not create a second provider dispatcher.

- [ ] **Step 2: Run command/catalog RED**

Run:

```bash
node --import tsx --test tests/commands.test.ts tests/commands-catalog.test.ts tests/cli.test.ts tests/integration.test.ts
```

Expected: FAIL on the missing provider subcommands and transaction delegation while old snapshots remain GREEN.

- [ ] **Step 3: Implement catalog-driven provider dispatch**

Extend `CommandContext` with one provider controller and a surface factory. Keep the flat catalog architecture: `provider` remains one handler ID; its handler parses only the first exact subcommand token. Unknown and partial tokens remain unknown. Route new subcommands to the shared controller/orchestrator; do not duplicate health or credential logic in `commands.ts`.

For `disable`/`disconnect`, use the existing approval UI. YOLO does not bypass this provider-account mutation; this is a setup confirmation, not a coding-tool approval. Cancellation leaves the chat running. Keep `/provider` bare output exact by branching before rendering the richer `status` view.

Update the catalog usage/description and regenerate the README command block from the catalog:

```bash
node --import tsx scripts/render-command-docs.ts
node --import tsx scripts/render-command-docs.ts --check
```

Add concise prose outside generated markers: OpenRouter Stable in Slice 1; Anthropic/Claude subscription Coming soon and not connectable; Cross is optional/on-demand and remains off after setup.

- [ ] **Step 4: Run command, docs, privacy, and type gates**

Run:

```bash
node --import tsx --test tests/commands.test.ts tests/commands-catalog.test.ts tests/cli.test.ts tests/integration.test.ts tests/setup-ui.test.ts
node --import tsx scripts/render-command-docs.ts --check
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
```

Expected: all tests PASS and README generation is byte-current.

- [ ] **Step 5: Commit commands and documentation**

```bash
git add src/commands.ts src/command-catalog.ts src/cli.ts src/setup-ui.ts README.md tests/commands.test.ts tests/commands-catalog.test.ts tests/cli.test.ts tests/integration.test.ts scripts/render-command-docs.ts
git commit -m "feat: expose provider setup commands"
```

---

### Task 10: Real Terminal, Migration, Privacy, and Release Verification

**Files:**
- Create: `tests/provider-setup-pty.test.ts`
- Create: `tests/provider-privacy.test.ts`
- Create: `tests/fixtures/provider-setup-pty-harness.mjs`
- Modify: `tests/app-home-migration.test.ts`
- Modify: `tests/integration.test.ts`
- Modify: `tests/tui.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/credentials.test.ts`
- Modify: `package.json` only if a dedicated provider PTY script is required; otherwise use the existing release PTY gate.

**Interfaces:**
- Consumes: the built CLI/TUI, the existing POSIX PTY harness style in `scripts/check-pty.mjs`, sanitized historical app-home fixtures, and the central credential scanner.
- Produces: no new production behavior; this task proves the integrated Slice-1 contract.

- [ ] **Step 1: Add the real POSIX PTY RED before adapting secret input**

Spawn the built setup surface in a real PTY on macOS/Linux with a fake local provider adapter and isolated app home. The harness must prove:

- stdin/stdout are real TTYs and the setup view remains live;
- a complete synthetic credential pasted with bracketed-paste framing, outer Unicode whitespace, and CRLF is submitted exactly once only after the later explicit Enter;
- the credential is never rendered in plain text, logs, failure output, snapshots, or environment diagnostics;
- an otherwise plausible credential containing NUL, ANSI, or an embedded control character is rejected locally with zero adapter/keychain/config calls;
- a rejected value clears the secret buffer before retry;
- Escape from secret/model setup before activation returns to a live `setup-required` chat; Escape from the post-activation Cross screen keeps the new route ready and behaves exactly like `Later`;
- no claim is made for ConPTY on a non-Windows host.

Reuse the existing PTY dependency/harness pattern; do not relabel fake `isTTY` streams as real PTY evidence.

- [ ] **Step 2: Add historical and privacy integration REDs**

Extend the sanitized app-home fixture to cover:

- all config model roles and at least two historical session model preferences;
- legacy fixed inference and management account identifiers represented only by injected fake stores, never real secret bytes;
- first startup locally creates one migrated OpenRouter connection and route projections without provider/keychain calls;
- opening/saving each historical chat lazily persists its optional route without rewriting the other;
- second startup plus second open/save is byte/state stable;
- future/corrupt provider state produces no mutation, setup prompt, credential deletion, or network call;
- activation-journal recovery produces exactly the old or new credential/route tuple;
- all output/events/config/journals omit complete synthetic keys, raw `creator_user_id`, home paths, and provider response bodies.

In `tests/provider-privacy.test.ts`, recursively read the provider-specific committed fixtures and all serialized artifacts produced by its temp-home fixture, run `scanForSecrets()` from `src/redaction.ts`, reject macOS/Linux/Windows private-home path forms, and assert that the synthetic creator ID (assembled from separate fragments in the test) is absent. The literal field name `creator_user_id` is allowed because the adapter must parse the documented API field; an actual field value is not.

- [ ] **Step 3: Run the PTY and integration REDs, then make only regression-driven fixes**

Run:

```bash
npm run build
node --import tsx --test tests/provider-setup-pty.test.ts tests/app-home-migration.test.ts tests/integration.test.ts tests/tui.test.ts tests/cli.test.ts tests/credentials.test.ts
```

Expected before the final wiring fixes: at least the real paste/secret lifecycle and historical multi-chat assertions fail. Make only fixes required by those named failures; do not broaden into Codex/Anthropic runtime work.

- [ ] **Step 4: Run all focused Slice-1 gates**

Run:

```bash
node --import tsx --test \
  tests/backends.test.ts \
  tests/provider-state.test.ts \
  tests/provider-activation.test.ts \
  tests/openrouter-backend.test.ts \
  tests/setup.test.ts \
  tests/setup-ui.test.ts \
  tests/provider-setup-pty.test.ts \
  tests/provider-privacy.test.ts \
  tests/config.test.ts \
  tests/credentials.test.ts \
  tests/openrouter.test.ts \
  tests/cli.test.ts \
  tests/cli-entrypoint.test.ts \
  tests/commands.test.ts \
  tests/commands-catalog.test.ts \
  tests/tui.test.ts \
  tests/session.test.ts \
  tests/app-home-migration.test.ts \
  tests/integration.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
node --import tsx scripts/render-command-docs.ts --check
```

Expected: all tests PASS; only pre-existing, explicitly platform-gated Windows tests may skip on macOS.

- [ ] **Step 5: Run repository-wide release and privacy gates**

Run:

```bash
npm test
npm run build
node scripts/check-package.mjs
node scripts/check-release-metadata.mjs --tag v0.4.1
node --import tsx --test tests/provider-privacy.test.ts
git diff --check
git status --short --untracked-files=all
```

Expected:

- full suite: 0 failures;
- both built `orcode`/`routercode` package shims still pass their existing smoke checks;
- the scanner finds no complete credential, raw provider account ID, or private absolute path; synthetic fragments must be assembled in tests;
- the only unrelated untracked entries remain under `.superpowers/brainstorm/` and are not staged.

- [ ] **Step 6: Request an independent code review and close findings RED-first**

Ask a fresh reviewer to inspect the base-to-head diff against the approved spec, specifically:

- saved-key precedence and environment fallback;
- false auth rejection on 403/429/5xx/offline/management failure;
- account fingerprint source and secret/account-ID leakage;
- crash/restart old-or-new atomicity and candidate cleanup;
- stale-generation and timeout races;
- legacy/current/future/corrupt migration, including historical sessions;
- non-interactive no-prompt and interactive cancel-keeps-chat;
- Anthropic Coming-soon zero-side-effect boundary;
- exact bare `/provider` compatibility and Cross remaining off.

For every P0/P1 finding: reproduce with a named failing test before production edits, implement the smallest fix, rerun the named test, then repeat focused, type, full, package, privacy, and diff gates. Do not accept a review based only on static inspection.

- [ ] **Step 7: Commit the integrated Slice 1**

Stage only files named by this plan and inspect the staged list before committing:

```bash
git diff --cached --name-only
git diff --cached --check
git commit -m "feat: add provider startup setup"
git status --short --untracked-files=all
```

Expected: the implementation commit is clean, the worktree contains no tracked changes, and `.superpowers/brainstorm/` remains untouched/untracked.

---

## Definition of Done

- Every ordinary start performs bounded, side-effect-free inspection of enabled providers only.
- Healthy saved OpenRouter setup starts silently; rejected saved credentials never trigger automatic environment-key replacement.
- OpenRouter setup, repair, model choice, route identity, and credential activation are durable and old-or-new across crashes.
- Plain and fullscreen modes use one setup controller and one secret-normalization path.
- Interactive cancellation keeps the chat alive; prompt/JSON never prompt and fail with typed setup-required output.
- Legacy configuration and historical session model references migrate locally, losslessly, lazily, and idempotently.
- Anthropic is visibly Coming soon and has no credential, network, executable, process, or state path.
- Bare `/provider`, legacy provider policy subcommands, app-home selection, keychain service names, and executable aliases remain compatible.
- Cross remains off until a later explicit `/collab` or `/cross` action.
- Focused, TypeScript, full test, real PTY, docs, package, release-metadata, privacy, diff, and independent-review gates are green with honest platform limits.
