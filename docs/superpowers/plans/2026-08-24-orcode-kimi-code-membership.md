# Orcode Kimi Code Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Kimi Code as an independent, owner-only Orcode Preview provider backed by a user-created Kimi Code membership API key, including setup, safe persistence, exact route binding, local interactive chat with tools, restart recovery, status, model selection, disable/enable, reconnect, and logout. Promotion from Preview to Stable is a separate live-contract gate in Task 8.

**Architecture:** The provider core becomes backend-aware without weakening the existing OpenRouter authority. Kimi gets a dedicated metadata client and backend adapter over `https://api.kimi.com/coding/v1`. A narrowly scoped protocol bridge translates the Responses requests emitted by `@openrouter/agent` into Kimi Chat Completions requests and converts JSON/SSE results back into the Responses contract consumed by the existing tool loop. A secretless fetcher acquires the exact connection-bound `ProviderCredentialAuthority` separately for each outbound model or metadata request, sends the request, and releases the credential callback before tool execution or approval waits; no Kimi secret, authenticated client, or secret-capturing closure is cached or returned.

**Tech Stack:** Node.js 22, TypeScript 5.9, `node:test`, built-in `fetch`, existing `@openrouter/agent`, direct exact dependency `@openrouter/sdk@0.13.67` for the supported custom `HTTPClient` seam, existing `@napi-rs/keyring`, `PrivateStore`, and terminal surfaces.

**Spec:** `docs/superpowers/specs/2026-08-24-orcode-kimi-code-membership-design.md`

**Safety amendment:** The referenced design labels the Kimi row Stable before the `/models` and end-to-end membership contract was authenticated. This executable plan deliberately narrows that label to Preview, defaults `k3` to 262,144 effective context unless authenticated documented capability proves more, and replaces the design's minimum status-only 401/403/429 mapping with the later-reviewed bounded provider-code classification below. Stable promotion is blocked until Task 8 records a separately authorized, sanitized authenticated catalog plus streaming text, reasoning, and one-tool-loop smoke; all normative design requirements not explicitly narrowed here remain binding.

## Global Constraints

- Backend ID is exactly `kimi-code`; billing realm is exactly `kimi-code-membership-provider-managed-overage`.
- The only Kimi endpoint is `https://api.kimi.com/coding/v1`. Do not try Moonshot/Kimi Open Platform, the official Kimi CLI store, OAuth/device login, browser cookies, environment variables, or alternate base URLs.
- Kimi authentication is one user-created membership API key stored only in Orcode's private credential store as `v1:kimi-code:<canonical UUID>`. No process-only Kimi credential exists in this release.
- All provider credentials and routes are exclusively for the local Orcode owner. Scheduled, unattended batch/JSON, relay, shared daemon, multi-user, collaborator, resale, and SaaS use reject before keychain or network access.
- Keep the top-level config schema at version 1. Upgrade only nested `providerSetup` from schema 1 to schema 2. Exact schema-1 state migrates locally and idempotently; future/corrupt nested state remains read-only and fails closed.
- Existing OpenRouter state, credentials, environment fallback, routes, sessions, activation journal v1, forget journal, `/key`, and runtime behavior remain compatible.
- One provider-wide coordinator and runtime-to-provider lock order protects every backend. Do not introduce per-backend locks that can interleave durable state.
- A Kimi candidate is bound to exact connection ID, backend, slot, account HMAC, realm, state revision, generation, purpose, absolute deadline, and signal. Revalidate the same tuple immediately before runtime publication.
- The account fingerprint is `HMAC(localIdentityKey, "orcode-kimi-code-credential/v1\0" + normalizedKey)` and is never displayed. A new key is conservatively a new account/billing route.
- Catalog setup uses `GET /models` only. Setup never sends a chat completion. Intersect the response with the frozen allowlist `k3`, `k3-256k`, `kimi-for-coding`, and `kimi-for-coding-highspeed`; ignore unknown IDs and hide missing IDs.
- Fixed classifications are: documented invalid-key 401 `kimi-code-auth-rejected`; recognized 401 model/tier entitlement denial `kimi-code-model-unavailable` without invalidating the key; 402 `kimi-code-membership-unavailable`; documented 403 access termination `kimi-code-access-terminated`; documented 403/429 usage exhaustion `kimi-code-limit-reached`; and recognized 429 overload/concurrency as retryable `kimi-code-overloaded`. Timeout, TLS, DNS, malformed data, unknown 4xx, and 5xx are retryable offline/unknown or fail-closed as the spec requires. Parse only a bounded frozen structured error-code/message allowlist, then discard the provider body. Never expose response bodies, headers, request IDs, paths, dependency messages, or secret fragments.
- Successful Kimi metadata or model calls leave spend `unknown`; Orcode does not fabricate quota, price, or remaining usage.
- The Responses-to-Chat bridge must preserve user/assistant/system content, tool definitions, tool calls, tool results, finish state, usage, abort, absolute deadline, `reasoning_content`, and streamed text/reasoning/tool deltas. Assistant reasoning paired with a tool call must round-trip into the following Chat request; missing required reasoning fails before the next network call. It must omit OpenRouter-only `provider`, `plugins`, fallback-model, and web-search fields.
- The bridge accepts only the request shapes Orcode itself emits. Unknown fields or malformed Kimi frames fail closed with fixed Orcode errors; no permissive pass-through exists.
- Kimi-only ordinary chat and compression must not read an OpenRouter key. The compressor uses the exact same Kimi connection and canonical route or is disabled; it never interprets an unbound OpenRouter model string. Image, voice, panel, and web features remain unavailable when their exact Kimi runtime contract is not implemented; copy must state that limitation rather than falling back to OpenRouter.
- Cross remains off after migration, setup, activation, model change, reconnect, enable/disable, logout, repair, recovery, and restart.
- `Mit Kimi anmelden · Coming soon` is presentation-only and produces zero process, browser, filesystem, credential, and network effects.
- No live Kimi credential is used by automated tests. A live smoke requires separate explicit operator authorization and sanitized evidence; without authenticated catalog, streaming text, reasoning, and one-tool-loop smoke evidence the descriptor remains Preview and the result is reported as fixture-verified only.
- Run package and release checks serially because package verification temporarily creates distribution artifacts.
- Preserve `.superpowers/brainstorm/`; do not stage, remove, or rewrite it.

## Pre-Execution Gate

- The implementation branch must contain provider-authority stabilization commit `0a7fec9` or a reviewed descendant.
- Before Task 1, run `node --import tsx --test tests/provider-authority.test.ts tests/provider-activation.test.ts tests/openrouter-backend.test.ts` and record the exact counts in the SDD ledger.
- Review the provider-authority callback deadline, durable adoption, candidate-permit, and stale-generation tests. Any open Critical/Important finding blocks implementation; a green test run alone does not waive review.
- Run `npm ls @openrouter/agent @openrouter/sdk` and record the resolved graph. Task 1 pins and proves the direct `@openrouter/sdk@0.13.67` seam before any provider schema change.

## File Structure

**Create**

- `src/model-runtime.ts` — provider-neutral model runtime contract and OpenRouter wrapper.
- `src/kimi-responses-bridge.ts` — strict Responses request/response and SSE translation.
- `src/kimi-code.ts` — endpoint, allowlist, safe metadata/model HTTP behavior, failures, and connection-bound client creation.
- `src/kimi-code-backend.ts` — Kimi descriptor and candidate/inspection/activation lifecycle.
- `tests/model-runtime.test.ts`
- `tests/kimi-responses-bridge.test.ts`
- `tests/kimi-code.test.ts`
- `tests/kimi-code-backend.test.ts`

**Modify**

- `package.json`, `package-lock.json` — pin the direct SDK seam used to inject the bridge.
- `src/backends.ts` — add Kimi backend and billing realm; permit one explicitly Preview Kimi adapter.
- `src/credentials.ts` — separate legacy credential kinds from versioned slot kinds.
- `src/provider-state.ts` — nested schema 2, backend-specific pointer/realm validation, and schema-1 migration.
- `src/config.ts` — integrate local idempotent nested migration without changing top-level schema.
- `src/provider-authority.ts` — backend-aware pointers, bindings, credential policy, and Kimi candidate proof.
- `src/provider-activation.ts` — backend-aware activation/journal v2 while recovering legacy journal v1.
- `src/setup.ts`, `src/setup-ui.ts` — backend-neutral activation and Kimi presentation.
- `src/openrouter.ts` — implement the provider-neutral runtime without behavior drift.
- `src/agent.ts`, `src/compressor.ts` — consume a route-bound runtime and remove OpenRouter-only assumptions.
- `src/cli.ts` — register/compose Kimi, resolve runtime by exact route, and apply execution-mode rejection before provider startup.
- `src/commands.ts`, `src/command-catalog.ts` — complete Kimi provider lifecycle commands and safe copy.
- `src/session.ts` — preserve exact historical Kimi route identity.
- `README.md` — generated command/setup documentation sourced from `src/command-catalog.ts`; `scripts/render-command-docs.ts` is verified unchanged.
- `tests/backends.test.ts`
- `tests/credentials.test.ts`
- `tests/provider-state.test.ts`
- `tests/config.test.ts`
- `tests/app-home-migration.test.ts`
- `tests/provider-authority.test.ts`
- `tests/provider-activation.test.ts`
- `tests/setup.test.ts`
- `tests/setup-ui.test.ts`
- `tests/agent.test.ts`
- `tests/commands.test.ts`
- `tests/commands-catalog.test.ts`
- `tests/cli.test.ts`
- `tests/integration.test.ts`
- `tests/session.test.ts`
- `tests/provider-privacy.test.ts`
- `tests/provider-setup-pty.test.ts`
- `tests/fixtures/provider-setup-pty-harness.mjs`

---

### Task 1: Prove the Pinned SDK Protocol Bridge Seam

**Files:**
- Create: `src/kimi-responses-bridge.ts`
- Create: `tests/kimi-responses-bridge.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces a minimal strict `createKimiResponsesFetcher` that can receive the exact `/responses` request emitted by the pinned `@openrouter/agent`, issue one injected Chat Completions request, and synthesize a result the pinned agent consumes.
- This is a feasibility gate. Tasks 2–8 do not proceed if the real pinned SDK cannot consume translated text plus a function call without deep imports or credential escape.

- [ ] **Step 1: Write the failing end-to-end characterization test**

Construct the real `OpenRouter` client with a direct `@openrouter/sdk` `HTTPClient`, call `client.callModel`, and consume `getText()`, `getResponse()`, `getReasoningStream()`, and a two-model-call tool loop. Use only a fixed public non-secret SDK sentinel where the constructor requires an API key; prove the bridge strips it and never forwards it upstream. The injected upstream fetch returns complete synthetic Chat Completions fixtures: streamed reasoning plus a fragmented tool call, followed by a final text response after the stored tool result. Assert the bridge received `/responses`, mapped the literal canonical `model`, input and tool schema, returned reasoning/function-call/text through the public agent API, and sent the first assistant message's exact `reasoning_content`, tool call, and tool result in the second Chat request. The test must not inspect private SDK objects.

Also assert abort propagation and that an unexpected SDK path, malformed body, or unknown input item produces a fixed sanitized error without issuing the upstream fetch.

- [ ] **Step 2: Run the RED test before the dependency/module exists**

```bash
node --import tsx --test tests/kimi-responses-bridge.test.ts
```

Expected: FAIL because the bridge and direct SDK seam do not exist.

- [ ] **Step 3: Pin the supported HTTP injection seam**

```bash
npm install --save-exact @openrouter/sdk@0.13.67
```

Import `HTTPClient` only from the direct package; importing through `@openrouter/agent/node_modules`, an internal file path, or an unexported symbol fails this gate.

- [ ] **Step 4: Implement the smallest real translation**

The spike implementation handles exactly the request/item fields observed from the real pinned client, streamed reasoning/text, one fragmented function call, one function result, and the second model response. It builds every synthetic Responses field explicitly and never spreads upstream objects. It emits the literal reasoning/output/function events accepted by the pinned SDK, including `response.reasoning_text.delta`, `response.content_part.done`, and `response.output_text.done`. Keep all fetch, URL, and clock seams injected. The only production URL accepted by the factory is `https://api.kimi.com/coding/v1/chat/completions`, though this test uses an injected fake fetch and sends no network request.

- [ ] **Step 5: Run GREEN and prove the test detects removal**

```bash
node --import tsx --test tests/kimi-responses-bridge.test.ts
npx tsc -p tsconfig.tests.json --noEmit
npm ls @openrouter/agent @openrouter/sdk
```

Temporarily replace the translator call with a fixed empty Responses result, rerun the focused test and observe failure, then restore the implementation and rerun GREEN.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/kimi-responses-bridge.ts tests/kimi-responses-bridge.test.ts
git commit -m "test: prove kimi chat bridge compatibility"
```

---

### Task 2: Kimi Provider Domain, Credential Slot, and Nested-State Migration

**Files:**
- Modify: `src/backends.ts`
- Modify: `src/credentials.ts`
- Modify: `src/provider-state.ts`
- Modify: `src/config.ts`
- Modify: `tests/backends.test.ts`
- Modify: `tests/credentials.test.ts`
- Modify: `tests/provider-state.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/app-home-migration.test.ts`

**Interfaces:**
- Produces `BackendId += "kimi-code"`, `BillingRealm += "kimi-code-membership-provider-managed-overage"`, `CredentialSlotKind`, `ProviderSetupStateV2`, and `migrateProviderSetupV1ToV2`.
- Preserves legacy `CredentialKind = "inference" | "management"` for `get/set/delete/has` and exact schema-1 OpenRouter state semantics.
- Schema 2 connections may carry backend-specific pointers; schema 1 is never silently reinterpreted as already supporting Kimi.

- [ ] **Step 1: Write failing behavior tests**

Add literal table cases proving:

```ts
const kimiRoute: RouteIdentityV1 = {
  version: 1,
  backendId: "kimi-code",
  accountFingerprint: "acct_local_kimi",
  billingRealm: "kimi-code-membership-provider-managed-overage",
  requestedModelId: "kimi-for-coding",
  canonicalModelId: "kimi-for-coding",
  resolutionState: "resolved",
};

assert.deepEqual(parseCredentialSlotRef("v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711"), {
  version: 1,
  kind: "kimi-code",
  id: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
});
```

Also prove wrong case, noncanonical UUID, `legacy:kimi-code`, `v1:inference` on a Kimi connection, Kimi realm on OpenRouter, and OpenRouter realm on Kimi all fail. Migrate a literal schema-1 fixture twice and assert the second serialized result is byte-identical, has `schemaVersion: 2`, adds no Kimi connection, and preserves all OpenRouter/Cross/session fields. Assert future schema 3 cannot be overwritten by an unrelated config save. Assert migration performs zero credential factory calls, zero environment reads, and zero fetches.

- [ ] **Step 2: Run the focused RED suite**

```bash
node --import tsx --test tests/backends.test.ts tests/credentials.test.ts tests/provider-state.test.ts tests/config.test.ts tests/app-home-migration.test.ts
```

Expected: FAIL on the missing `kimi-code` unions, slot parser, and schema-2 migration.

- [ ] **Step 3: Implement the exact domain split**

Use these public shapes:

```ts
export const BACKEND_IDS = ["openrouter", "kimi-code", "codex", "anthropic"] as const;

export type BillingRealm =
  | "openrouter-payg"
  | "kimi-code-membership-provider-managed-overage"
  | "chatgpt-subscription-provider-managed-overage"
  | "chatgpt-account-provider-managed-limits"
  | "none";

export type CredentialKind = "inference" | "management";
export type CredentialSlotKind = CredentialKind | "kimi-code";

export interface CredentialSlotRef {
  version: 1;
  kind: CredentialSlotKind;
  id: string;
}

export function parseCredentialSlotRef(value: unknown): CredentialSlotRef;
```

`CredentialStoreLike` legacy methods continue accepting only `CredentialKind`; slot methods accept `CredentialSlotKind`. The existing keychain service identifier stays unchanged. Add a dedicated Kimi slot account only through the versioned `provider-slot:v1:kimi-code:<uuid>` namespace.

Define schema 2 as a structural successor, not a union hidden behind a V1 name:

```ts
export const PROVIDER_SETUP_SCHEMA_VERSION = 2 as const;
export interface ProviderSetupStateV2 {
  schemaVersion: 2;
  revision: number;
  lifecycle: "never-configured" | "cancelled" | "migrated" | "configured";
  connections: ProviderConnectionStateV2[];
  defaultRoute: RouteIdentityV1 | null;
  cross: {
    enabled: false;
    preferredLead: RouteIdentityV1 | null;
    preferredChallenger: RouteIdentityV1 | null;
  };
}
export type ProviderSetupState = ProviderSetupStateV2 | ProviderStateIssue;
```

`parseCredentialSlotRef` accepts only the canonical string form and returns a frozen structured reference; store-internal validation reuses the same parser. Update call sites to the V2 name or provide an explicit deprecated type alias only when a wide mechanical rename would obscure the behavior. `validateProviderSetupState` accepts validated schema 1 through an explicit `migrateProviderSetupV1ToV2` path and accepts schema 2 idempotently; migration clones every field including `lifecycle`, changes only the nested version, validates the result, and never consults credentials/network.

- [ ] **Step 4: Run GREEN and regression tests**

```bash
node --import tsx --test tests/backends.test.ts tests/credentials.test.ts tests/provider-state.test.ts tests/config.test.ts tests/app-home-migration.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/backends.ts src/credentials.ts src/provider-state.ts src/config.ts tests/backends.test.ts tests/credentials.test.ts tests/provider-state.test.ts tests/config.test.ts tests/app-home-migration.test.ts
git commit -m "feat: add kimi provider state contracts"
```

---

### Task 3: Backend-Aware Credential Authority and Activation Journal

**Files:**
- Modify: `src/provider-authority.ts`
- Modify: `src/provider-activation.ts`
- Modify: `src/openrouter-backend.ts`
- Modify: `src/setup.ts`
- Modify: `src/cli.ts`
- Modify: `tests/provider-authority.test.ts`
- Modify: `tests/provider-activation.test.ts`
- Modify: `tests/openrouter-backend.test.ts`
- Modify: `tests/setup.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/provider-privacy.test.ts`
- Modify: `tests/integration.test.ts`

**Interfaces:**
- Consumes Task 2 backend/slot/state contracts.
- Produces backend policy, exact generic binding selection, Kimi credential proof support, `ProviderActivationJournalV2`, and backend-indexed adapter dispatch.
- Preserves OpenRouter compatibility wrappers and journal-v1 recovery.

- [ ] **Step 1: Write failing authority and crash-recovery tests**

Test a literal Kimi binding and request:

```ts
const binding: ProviderConnectionBindingV2 = {
  version: 2,
  stateRevision: 4,
  connectionId: "kimi-main",
  backendId: "kimi-code",
  enabled: true,
  credentialPointer: {
    kind: "versioned",
    slot: {
      version: 1,
      kind: "kimi-code",
      id: "v1:kimi-code:018f8d77-2d52-7cc0-8f6a-9fb1f3fc0711",
    },
  },
  accountFingerprint: "acct_local_kimi",
  billingRealm: "kimi-code-membership-provider-managed-overage",
  isDefault: true,
};
```

Prove the authority reads exactly this slot only inside the callback, never checks `OPENROUTER_API_KEY`, and returns `invalid-pointer` for another kind. Mutate revision, generation, connection, fingerprint, realm, and slot independently between inspection and publication; each mutation must return stale and publish nothing. Cover abort/deadline before and after every awaited boundary. Table-drive every activation boundary and recover to a complete old/new tuple. Feed a literal legacy OpenRouter journal v1 and prove it still recovers through the legacy path.

- [ ] **Step 2: Run the focused RED suite**

```bash
node --import tsx --test tests/provider-authority.test.ts tests/provider-activation.test.ts tests/openrouter-backend.test.ts
```

- [ ] **Step 3: Implement backend-bound authority policy**

Use these contracts:

```ts
export interface ProviderCredentialPolicy {
  backendId: "openrouter" | "kimi-code";
  savedSlotKinds: readonly CredentialSlotKind[];
  legacyInferenceAllowed: boolean;
  environmentVariable: "OPENROUTER_API_KEY" | null;
  billingRealm: "openrouter-payg" | "kimi-code-membership-provider-managed-overage";
  accountIdentity: "documented-provider-account" | "normalized-secret-hmac";
  secretFingerprintDomain: "orcode-kimi-code-credential/v1\0" | null;
}

export interface ProviderConnectionBindingV2 {
  version: 2;
  stateRevision: number;
  connectionId: string;
  backendId: "openrouter" | "kimi-code";
  enabled: boolean;
  credentialPointer: ProviderCredentialPointer;
  accountFingerprint: string;
  billingRealm: "openrouter-payg" | "kimi-code-membership-provider-managed-overage";
  isDefault: boolean;
}
```

`ProviderCredentialRequest` gains required `backendId`; environment eligibility is rejected structurally for Kimi. Keep `selectOpenRouterBinding` as a compatibility wrapper around an exact generic selector.

Update every production call in `src/openrouter-backend.ts` and `src/cli.ts` to pass `backendId: "openrouter"`, and every activation call in `src/setup.ts`/`src/cli.ts` to pass the exact selected backend. Update all structural test doubles in the listed test files in the same commit so both TypeScript projects are green at this task boundary.

- [ ] **Step 4: Implement journal v2 without reinterpreting v1**

```ts
export interface ProviderActivationJournalV2 {
  version: 2;
  transactionId: string;
  expectedRevision: number;
  phase: "prepared" | "credential-staged" | "config-committed";
  backendId: "openrouter" | "kimi-code";
  credentialSlotKind: CredentialSlotKind;
  candidateSlot: CredentialSlotRef;
  previousSlot: CredentialSlotRef | { version: 0; kind: "inference"; id: "legacy:inference" } | null;
  candidateConnectionId: string;
  candidateRoute: RouteIdentityV1;
  expectedProviderSetupSha256: string;
  candidateProviderSetupSha256: string;
}
```

Activation request gains required `backendId`. The coordinator receives a registry or exact adapter resolver rather than one OpenRouter adapter. Version 1 journals remain parsed by a frozen OpenRouter-only validator; new writes are version 2. Slot kind must equal backend policy before any write.

- [ ] **Step 5: Run GREEN plus mutation cases**

```bash
node --import tsx --test tests/provider-authority.test.ts tests/provider-activation.test.ts tests/openrouter-backend.test.ts tests/setup.test.ts tests/cli.test.ts tests/provider-privacy.test.ts tests/integration.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/provider-authority.ts src/provider-activation.ts src/openrouter-backend.ts src/setup.ts src/cli.ts tests/provider-authority.test.ts tests/provider-activation.test.ts tests/openrouter-backend.test.ts tests/setup.test.ts tests/cli.test.ts tests/provider-privacy.test.ts tests/integration.test.ts
git commit -m "refactor: make provider authority backend aware"
```

---

### Task 4: Strict Kimi Metadata Client and Backend Adapter

**Files:**
- Create: `src/kimi-code.ts`
- Create: `src/kimi-code-backend.ts`
- Create: `tests/kimi-code.test.ts`
- Create: `tests/kimi-code-backend.test.ts`
- Modify: `src/backends.ts`
- Modify: `tests/backends.test.ts`
- Modify: `tests/provider-privacy.test.ts`

**Interfaces:**
- Produces `KIMI_CODE_API_BASE`, `KIMI_CODE_MODELS`, `KimiCodeRequestError`, `describeKimiCodeFailure`, `KimiCodeService`, `KIMI_CODE_DESCRIPTOR`, and `KimiCodeBackendAdapter`.
- All fetch, clock, and HMAC seams are injected. Production never receives a method returning the raw key.

- [ ] **Step 1: Write failing client/adapter contract tests**

Use complete synthetic responses and assert observable outcomes, not mocks themselves. Cover valid catalog intersection in provider order, duplicate IDs, missing IDs, unknown IDs, malformed JSON, wrong content type, oversized body, invalid-key 401, tier/model-entitlement 401, 402, access-termination 403, usage-exhaustion 403, rolling/monthly/overload/concurrency 429, 500, DNS/TLS, timeout, and abort. A model-entitlement 401 must keep the credential valid and hide only the unavailable model; only the frozen invalid-key shapes may classify the credential rejected. For every failure insert unique body/header/request-ID/secret canaries and assert none appear in public errors, events, serialized candidate state, or logs.

Prove inspection calls exactly:

```text
GET https://api.kimi.com/coding/v1/models
Authorization: Bearer fixture-kimi-membership-key
User-Agent: orcode/0.4.1
Accept: application/json
```

and never calls `/chat/completions`. Prove a Kimi key cannot be used with any other origin and an OpenRouter key path cannot enter the adapter.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/kimi-code.test.ts tests/kimi-code-backend.test.ts tests/backends.test.ts
```

- [ ] **Step 3: Implement frozen metadata and safe failures**

```ts
export const KIMI_CODE_API_BASE = "https://api.kimi.com/coding/v1" as const;

export const KIMI_CODE_MODELS = Object.freeze([
  { id: "k3", displayName: "Kimi K3", advertisedMaxContext: 1_048_576, effectiveContextDefault: 262_144, reasoningEfforts: ["low", "high", "max"], thinkingRequired: true },
  { id: "k3-256k", displayName: "Kimi K3 256K", advertisedMaxContext: 262_144, effectiveContextDefault: 262_144, reasoningEfforts: ["low", "high", "max"], thinkingRequired: true },
  { id: "kimi-for-coding", displayName: "Kimi K2.7 Code", advertisedMaxContext: 262_144, effectiveContextDefault: 262_144, reasoningEfforts: null, thinkingRequired: true },
  { id: "kimi-for-coding-highspeed", displayName: "Kimi K2.7 Code HighSpeed", advertisedMaxContext: 262_144, effectiveContextDefault: 262_144, reasoningEfforts: null, thinkingRequired: true },
] as const);

export type KimiCodeFailureCode =
  | "kimi-code-auth-rejected"
  | "kimi-code-model-unavailable"
  | "kimi-code-membership-unavailable"
  | "kimi-code-access-terminated"
  | "kimi-code-limit-reached"
  | "kimi-code-overloaded"
  | "kimi-code-offline"
  | "kimi-code-invalid-response"
  | "kimi-code-cancelled";
```

The adapter keeps candidate metadata only: candidate ID, connection ID, fingerprint, exact model catalog, generation, and deadline. Candidate secret ownership stays in `ProviderCredentialAuthority`. Fingerprint creation uses the exact domain string from Global Constraints. `k3` remains at the conservative 262,144 effective context unless a separately documented authenticated capability field explicitly proves 1,048,576 for this account; mere presence of the ID does not prove the larger entitlement.

The official documentation reviewed on 2026-08-24 documents `/chat/completions` and the four model IDs but not an authenticated `/models` response contract. Therefore this adapter is Preview: a strict runtime `GET /models` success can enable that local connection, while absent/malformed/changed catalog shape leaves it offline and sends no completion. Stable promotion requires Task 8's authenticated catalog evidence or an updated approved spec; a 401 from the unauthenticated endpoint alone is not evidence of catalog semantics.

- [ ] **Step 4: Run GREEN and privacy scan**

```bash
node --import tsx --test tests/kimi-code.test.ts tests/kimi-code-backend.test.ts tests/backends.test.ts tests/provider-privacy.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/kimi-code.ts src/kimi-code-backend.ts src/backends.ts tests/kimi-code.test.ts tests/kimi-code-backend.test.ts tests/backends.test.ts tests/provider-privacy.test.ts
git commit -m "feat: add safe kimi membership adapter"
```

---

### Task 5: Provider-Neutral Runtime and Complete Responses-to-Chat Protocol Bridge

**Files:**
- Create: `src/model-runtime.ts`
- Modify: `src/kimi-responses-bridge.ts`
- Create: `tests/model-runtime.test.ts`
- Modify: `tests/kimi-responses-bridge.test.ts`
- Modify: `src/openrouter.ts`
- Modify: `src/agent.ts`
- Modify: `src/compressor.ts`
- Modify: `src/reasoning.ts`
- Modify: `src/types.ts`
- Modify: `src/session.ts`
- Modify: `src/runlog.ts`
- Modify: `tests/openrouter.test.ts`
- Modify: `tests/agent.test.ts`
- Modify: `tests/compressor.test.ts`
- Modify: `tests/reasoning.test.ts`
- Modify: `tests/session.test.ts`
- Modify: `tests/runlog.test.ts`

**Interfaces:**
- Produces a route-bound, secretless `ModelRuntime`; its Kimi fetcher acquires credential authority for one outbound request only and releases before any tool or approval code runs.
- Produces `createKimiResponsesFetcher` and a direct SDK `HTTPClient` injection; no deep import from `node_modules` is allowed.
- Keeps the existing `@openrouter/agent` conversation/tool engine so tool approval, journals, and event semantics do not fork by provider.

- [ ] **Step 1: Write failing provider-neutral agent tests**

Instantiate `OrcodeAgent` with a fake `ModelRuntime` and no `OpenRouterService`. Prove main and compressor clients come from the exact route runtime, Kimi spend/pricing remains `unknown` without being displayed or persisted as free/zero, Kimi does not request OpenRouter web/provider fields, and Kimi-only text/tool chat performs zero OpenRouter credential/service calls. In a real two-call tool loop, assert the authority callback has already settled before the tool handler or approval seam is entered, then is acquired afresh for the second model request. Preserve existing OpenRouter request/result fixtures byte-for-byte.

- [ ] **Step 2: Write failing bridge fixtures**

Use literal Responses requests and Chat Completions replies. Cover:

- system/developer/user/assistant text;
- input images rejected before Kimi network until image capability is separately implemented;
- JSON-schema tools and `function_call`/`function_call_output` pairing;
- nonstream JSON completion;
- SSE text chunks, `reasoning_content`, fragmented tool-call name/arguments, finish reason, `[DONE]`, and usage;
- second-request round-trip of assistant `reasoning_content` with its tool calls and tool results;
- K3 effort mapping `auto→high`, `low→low`, `medium|high→high`, `xhigh|max→max`; reject `none`, token-budget, and unknown effort before network;
- K2.7 keeps thinking enabled, omits unsupported effort tuning, and rejects explicit off/budget before network;
- malformed JSON/SSE, unknown event, missing tool-call ID, duplicate terminal frame, oversized line/body, abort, and deadline;
- sanitization of secret, authorization header, body canary, response header, request ID, and dependency error.

The expected synthetic Responses stream uses literal event names consumed by the pinned SDK:

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.reasoning_text.delta
response.function_call_arguments.delta
response.function_call_arguments.done
response.output_item.done
response.completed
```

- [ ] **Step 3: Run RED**

```bash
node --import tsx --test tests/model-runtime.test.ts tests/kimi-responses-bridge.test.ts tests/agent.test.ts tests/openrouter.test.ts tests/compressor.test.ts tests/reasoning.test.ts tests/session.test.ts tests/runlog.test.ts
```

- [ ] **Step 4: Complete the runtime contract**

```ts
export type RuntimeModelPrice =
  | { kind: "known"; promptUsdPerToken: number; completionUsdPerToken: number }
  | { kind: "unknown" };

export interface RuntimeModelInfo {
  id: string;
  name: string;
  contextLength: number;
  reasoning: ModelInfo["reasoning"];
  price: RuntimeModelPrice;
}

export type ModelDispatchFields =
  | {
      backendId: "openrouter";
      models: readonly string[];
      provider: ReturnType<typeof providerField>;
      plugins?: readonly ReturnType<typeof webSearchPlugin>[];
    }
  | {
      backendId: "kimi-code";
      model: "k3" | "k3-256k" | "kimi-for-coding" | "kimi-for-coding-highspeed";
    };

export interface ModelRuntime {
  readonly backendId: "openrouter" | "kimi-code";
  onConnectionEvent(listener: ConnectionEventListener): () => void;
  createClient(request: {
    route: RouteIdentityV1;
    scope: "main" | "compressor";
  }): OpenRouter;
  inspectSpend(signal?: AbortSignal): Promise<{ kind: "known"; balance: BalanceInfo } | { kind: "unknown" }>;
  listModels(modelId: string, signal?: AbortSignal): Promise<RuntimeModelInfo[]>;
  dispatchFields(input: { route: RouteIdentityV1; allowWeb: boolean }): ModelDispatchFields;
  safeMessage(error: unknown): string;
}
```

Wrap `OpenRouterService` without changing its request bytes. Kimi `createClient` returns a client whose custom fetcher contains only the exact route/binding and a secretless authority handle. If the SDK constructor requires an API key, supply one frozen public sentinel, require the bridge to remove it, and assert it can never become an upstream Authorization value. For each `/responses` fetch, the bridge validates/translates the body, enters `ProviderCredentialAuthority.withCredential` with `backendId: "kimi-code"`, `environmentEligibility: "forbidden"`, exact connection and deadline, constructs the sole upstream Authorization header plus truthful Orcode User-Agent inside the callback, awaits only `fetch()` until headers/error classification are available, and settles the authority callback. The successful `Response` body carries no credential and streams afterward under the existing active-run guard; provider mutation remains blocked until the run drains. Tool handlers and approvals execute with no authority callback open. Kimi `inspectSpend` returns `{ kind: "unknown" }`; `RuntimeModelInfo.price` remains unknown and the compressor budget cannot treat it as zero. The compressor uses the same route/runtime or returns an explicit uncompressed result. Clear client/conversation/model caches whenever the exact route tuple changes.

Add `costKnowledge: "known" | "unknown"` to `AgentRunResult` and persisted model-end/run summaries. Existing numeric OpenRouter cost fields remain for compatibility, but Kimi sets `costKnowledge: "unknown"`; session budget accumulation skips unknown amounts and every formatter renders `unbekannt/providerverwaltet`, never `0,00 $` or `kostenlos`.

- [ ] **Step 5: Complete strict translation and verify RED-GREEN**

Translate only explicit fields. Never spread input objects into upstream payloads. Validate every upstream frame before emitting a synthetic Responses object/stream. Revert the production bridge temporarily and run its regression test once to prove the new test fails, then restore and rerun GREEN.

```bash
node --import tsx --test tests/model-runtime.test.ts tests/kimi-responses-bridge.test.ts tests/agent.test.ts tests/openrouter.test.ts tests/compressor.test.ts tests/reasoning.test.ts tests/session.test.ts tests/runlog.test.ts
npx tsc -p tsconfig.tests.json --noEmit
npm ls @openrouter/agent @openrouter/sdk
```

- [ ] **Step 6: Commit**

```bash
git add src/model-runtime.ts src/kimi-responses-bridge.ts src/openrouter.ts src/agent.ts src/compressor.ts src/reasoning.ts src/types.ts src/session.ts src/runlog.ts tests/model-runtime.test.ts tests/kimi-responses-bridge.test.ts tests/openrouter.test.ts tests/agent.test.ts tests/compressor.test.ts tests/reasoning.test.ts tests/session.test.ts tests/runlog.test.ts
git commit -m "feat: run kimi through a strict chat bridge"
```

---

### Task 6: Kimi Setup, Commands, Activation, and Owner-Only Execution Policy

**Files:**
- Modify: `src/setup.ts`
- Modify: `src/setup-ui.ts`
- Modify: `src/commands.ts`
- Modify: `src/command-catalog.ts`
- Modify: `src/cli.ts`
- Modify: `tests/setup.test.ts`
- Modify: `tests/setup-ui.test.ts`
- Modify: `tests/commands.test.ts`
- Modify: `tests/commands-catalog.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/integration.test.ts`

**Interfaces:**
- Consumes Tasks 1–5 contracts.
- Produces a registry containing OpenRouter, Kimi, and Anthropic Coming-soon; backend-neutral setup activation; exact runtime resolution by route; complete Kimi command lifecycle; early execution-policy gate.

- [ ] **Step 1: Write failing surface and policy tests**

Prove the setup entries are exactly:

```text
OpenRouter             Stable · API-Guthaben · viele Modelle
Kimi Code Abo          Preview · Membership-Key · Coding-Modelle
Anthropic / Claude-Abo Coming soon
```

Selecting Kimi explains third-party membership-key use, provider-managed limits, and possible paid Extra Usage. Test paste normalization, cancel, retry, all four catalog-gated models, model choice, key replacement confirmation, restart, and Cross remaining off. Activate the OAuth Coming-soon row and assert zero browser/process/filesystem/keychain/network effects.

Exercise `/provider connect|enable|disable|reconnect|models|logout kimi-code` and `/provider status`. Assert status contains no key fragment, fingerprint, account ID, email, raw quota, or fabricated zero. Test two providers in either activation order and exact selected connection behavior.

Table-drive execution modes `local-interactive-owner`, `json`, `piped`, `scheduled`, `batch`, `relay`, `multi-user`, `collaborator`, `shared-service`, and `unenrolled-device`. Derive this typed mode before provider construction and pass it as required `ProviderRuntimeInput.executionMode`; it must already be present when `createProviderRuntime` and `inspectStartup` are called. Only `local-interactive-owner` may reach Kimi credential or network seams. Every other mode returns the fixed Kimi execution-policy denial before Kimi credential construction/read, authenticated migration inspection, backend inspection, or network access. Existing OpenRouter prompt/JSON/piped behavior remains byte-for-byte compatible and is not rejected by the Kimi-only policy.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/setup.test.ts tests/setup-ui.test.ts tests/commands.test.ts tests/commands-catalog.test.ts tests/cli.test.ts tests/integration.test.ts
```

- [ ] **Step 3: Generalize setup activation**

Replace `activateOpenRouter` with:

```ts
async function activateProvider(input: {
  backendId: "openrouter" | "kimi-code";
  connectionId?: string;
  candidate: string;
  requestedModelId: string;
  surface: SetupSurface;
  context: SetupExecutionContext;
}): Promise<ProviderActivationResult>
```

OpenRouter retains saved/environment/process-only choices. Kimi always sets `persistence: "persisted"`, `environmentEligibility: "forbidden"`, and `requireCandidatePermit: true`.

- [ ] **Step 4: Compose route-bound runtimes**

Change `ProviderRuntime` from exposing only `openRouter` to:

```ts
export interface ProviderRuntime extends ProviderRouteIntentPort, ProviderCommandIntentPort {
  readonly credentials: CredentialStore;
  modelRuntime(route: RouteIdentityV1): ModelRuntime;
  // existing route/setup/session methods remain
}
```

Add this required input before the factory is called:

```ts
export type ProviderExecutionMode =
  | "local-interactive-owner"
  | "json"
  | "piped"
  | "scheduled"
  | "batch"
  | "relay"
  | "multi-user"
  | "collaborator"
  | "shared-service"
  | "unenrolled-device";

export interface ProviderRuntimeInput {
  startup: StartupStorageResult;
  environment: Readonly<Record<string, string | undefined>>;
  requestedModel?: string;
  executionMode: ProviderExecutionMode;
}
```

`modelRuntime(route)` validates the exact state revision/connection binding and returns only a secretless handle. `runWithReadyRoute` holds the existing active-run/mutation guard across the complete model stream, tool/approval loop, and compressor lifecycle. Inside that guarded lifecycle, each individual Kimi metadata or model HTTP request independently enters `ProviderCredentialAuthority.withCredential`, awaits only authenticated request dispatch plus response-header/error classification, and settles the callback before response streaming, tools, approvals, or a subsequent model request. It never caches the secret, authenticated client, secret-capturing closure, pointer, or permit. `OrcodeAgent` is constructed/rebound with the exact route runtime before each run under `runWithReadyRoute`.

- [ ] **Step 5: Run GREEN and old provider regressions**

```bash
node --import tsx --test tests/setup.test.ts tests/setup-ui.test.ts tests/commands.test.ts tests/commands-catalog.test.ts tests/cli.test.ts tests/integration.test.ts tests/openrouter.test.ts tests/provider-activation.test.ts tests/provider-authority.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/setup.ts src/setup-ui.ts src/commands.ts src/command-catalog.ts src/cli.ts tests/setup.test.ts tests/setup-ui.test.ts tests/commands.test.ts tests/commands-catalog.test.ts tests/cli.test.ts tests/integration.test.ts
git commit -m "feat: expose kimi membership setup and commands"
```

---

### Task 7: Session Identity, Privacy, PTY, and Recovery Closure

**Files:**
- Modify: `src/session.ts`
- Modify: `tests/session.test.ts`
- Modify: `tests/provider-privacy.test.ts`
- Modify: `tests/provider-setup-pty.test.ts`
- Modify: `tests/fixtures/provider-setup-pty-harness.mjs`
- Modify: `tests/provider-activation.test.ts`
- Modify: `tests/provider-authority.test.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Closes historical route, privacy, lifecycle, abort/deadline, and terminal parity gates on the assembled runtime.

- [ ] **Step 1: Add failing historical and adversarial tests**

Persist a session with the exact Kimi route tuple, restart with OpenRouter as default, and prove the session either binds the same Kimi connection/account/model or becomes setup-required; it never silently executes through OpenRouter or another Kimi fingerprint. Repeat after key replacement, disable/enable, reconnect, logout, pending forget, recovery journal, and stale generation.

Create synthetic secret/header/body/path canaries and scan config, provider state, sessions, run logs, events, JSON output, errors, PTY transcripts, reports, temp files, activation journals, and forget journals. Add POSIX paste/cancel/retry/model-choice flows. Keep native Windows assertions platform-gated.

For every awaited authority, catalog, bridge, activation, config, readback, runtime-bind, and cleanup boundary, inject abort/deadline and assert no late proof, state, route, event, UI, or client publication.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/session.test.ts tests/provider-privacy.test.ts tests/provider-setup-pty.test.ts tests/provider-activation.test.ts tests/provider-authority.test.ts tests/cli.test.ts
```

- [ ] **Step 3: Apply only the named lifecycle closures and run GREEN**

Make changes only where a RED test requires one of these exact closures:

- `SessionStore.setPreferences`, `normalizeSession`, and the session three-way merge persist or reject the complete Kimi `RouteIdentityV1`; they never project a Kimi route from a model string or replace it with the current default.
- `SessionProviderRuntimeGuard.beginRun` keeps provider mutation excluded until streaming, tools, approvals, and compression have all settled.
- `DefaultProviderRuntime.adoptSession`, `currentSessionRoute`, `selectSessionRoute`, and `runWithReadyRoute` require the exact backend/connection/account/realm/model/generation binding and return setup-required on any mismatch; there is no cross-provider fallback.
- `ProviderCredentialAuthority.withCredential` abort/deadline paths cancel the active request and cannot publish a late proof, credential result, or client.
- `ProviderActivationCoordinator.recoverAndRun`, `recoverProviderCredentialForget`, and backend-aware journal validation preserve exact backend/slot/generation ownership across every awaited boundary and fail closed on ambiguous v1/v2 recovery.
- PTY setup uses the same `activateProvider` path as plain/fullscreen setup and scrubs the synthetic key before transcript or error publication.

Do not add recovery bypasses, alternate code paths, or conditional feature shims. Every fix must preserve exact tuple checks and Cross-off state. If the RED suite requires a file outside the list above, stop Task 7 and record a plan amendment in the SDD ledger before editing it.

```bash
node --import tsx --test tests/session.test.ts tests/provider-privacy.test.ts tests/provider-setup-pty.test.ts tests/provider-activation.test.ts tests/provider-authority.test.ts tests/cli.test.ts
npm run test:pty
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/session.ts tests/session.test.ts tests/provider-privacy.test.ts tests/provider-setup-pty.test.ts tests/fixtures/provider-setup-pty-harness.mjs tests/provider-activation.test.ts tests/provider-authority.test.ts tests/cli.test.ts
git commit -m "test: close kimi privacy and recovery gates"
```

---

### Task 8: Documentation, Packaging, and Frozen-Tree Preview Evidence

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Verify unchanged generator: `scripts/render-command-docs.ts`
- Verify existing gates: `tests/commands-catalog.test.ts`, `tests/cli-entrypoint.test.ts`, `tests/release-metadata.test.ts`

**Interfaces:**
- Produces truthful user documentation and a complete branch/package verification record. It does not publish, tag, bump a version, claim Windows support, or claim a live Kimi account test unless those actions were separately authorized and evidenced.

- [ ] **Step 1: Update generated documentation inputs**

Document Kimi membership-key setup, exact supported models, owner-only local interactive restriction, provider-managed limits/possible Extra Usage, unsupported OAuth/Open Platform/relay/batch, command lifecycle, and Cross-off behavior. Keep the generated command table single-sourced.

- [ ] **Step 2: Scan for unfinished placeholders and secret-bearing artifacts**

```bash
rg -n "TODO|TBD|FIXME|placeholder|Coming soon.*Kimi Code Abo" src tests README.md package.json
rg -n "api\.kimi\.com|Kimi Code|kimi-code" README.md src tests package.json
git diff --check
```

Classify every match; no executable Kimi path may remain a placeholder. The OAuth row is the only intentional Kimi Coming-soon copy.

- [ ] **Step 3: Run the frozen-tree verification serially**

```bash
npm run check
npm run build
npm run test:pty
npm run check:package
npm run check:release -- --tag v0.4.1
git diff --check
git status --short
```

Run `check:package` and `check:release` serially. `v0.4.1` is the exact current package-metadata tag for this branch; this command validates metadata consistency only and does not create a tag, publish a package, authorize release, or claim that Kimi shipped in 0.4.1. If a separately approved version change occurred, amend this plan and its changelog/version evidence before running a different tag. Capture exact pass/fail counts and exit codes. If one command changes tracked or generated files, freeze those changes and restart the entire sequence from `npm run check`. A macOS run produces no Windows evidence; any Windows support claim requires the matching native CI/host result.

- [ ] **Step 4: Review every spec gate against evidence**

Build a checklist for every normative section 1–14 of the spec and link each row to a test, source diff, command result, or explicit blocked/not-run fact. Mark authenticated catalog, streamed text, reasoning, and one-tool-loop smokes `not run — requires explicit credential authorization` unless separately authorized. Without all four sanitized live results, the provider stays Preview even when fixtures and repository checks pass; there is no Stable or release-ready claim.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: publish kimi membership provider guidance"
```
