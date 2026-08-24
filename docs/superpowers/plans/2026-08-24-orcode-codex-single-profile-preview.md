# Orcode Codex Single-Profile Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one owner-only ChatGPT-through-Codex Preview route that uses the official app-server/login surfaces from an isolated Orcode-owned runtime home and can return text or a centrally validated patch without ever giving Codex the live workspace.

**Architecture:** Extend the Kimi-plan provider registry and nested provider-state schema with exactly one managed Codex connection named `codex-single`. A dedicated app-server client owns login/account/rate-limit/thread protocol, while `PreparedWorkspaceView`, `ManagedRuntimeSandbox`, `ManagedOperationJournal`, and `PatchProposalCoordinator` keep task content, process effects, and live-workspace mutation behind explicit Orcode boundaries. The existing `SetupOrchestrator` remains the provider lifecycle owner; no profile collection, target selection, subscription handoff, or automatic route switching is introduced.

**Tech Stack:** Node.js 22, TypeScript 5.9, `node:test`, official allowlisted `codex app-server` JSON-RPC over local stdio, existing `@napi-rs/keyring`, existing `PrivateStore`, existing `WorkspaceGuard`/`ChangeJournal`; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-22-orcode-0.7-design.md`, amended for provider startup by `docs/superpowers/specs/2026-08-23-orcode-startup-provider-setup-design.md`

**Prerequisite:** Execute this plan only after all eight tasks in `docs/superpowers/plans/2026-08-24-orcode-kimi-code-membership.md` are implemented and reviewed. In particular, this plan consumes `ProviderSetupStateV2`, canonical OpenRouter/Kimi keychain slot pointers, the backend-aware activation journal, and the provider-neutral model runtime; it does not reimplement or reorder their migrations.

## Global Constraints

- This is the prerequisite **single-profile Codex Preview** only. The one stable local connection ID is `codex-single`; there is no profile list, second profile, profile selector, account handoff, account rotation, automatic failover, round robin, or background continuation.
- The route is owner-only. Collaborator-originated work cannot inspect, select, or dispatch through the owner's Codex connection; collaborators remain bring-your-own-provider only.
- The locally inspected runtime is `codex-cli 0.142.5`. Its observed `account/read` result contains an email and `planType`, but no documented `workspace_class` or stable workspace ID. A transient normalized email may produce a local keyed `derived` fingerprint for this single route, but the missing workspace fact keeps owner subscription handoff unavailable. Do not add a handoff eligibility flag, prompt, or workaround in this plan.
- Use only an explicitly allowlisted official `codex app-server` executable and its documented `account/login/start`, `account/login/cancel`, `account/read`, `account/rateLimits/read`, thread, turn, and logout methods. Do not use `chatgptAuthTokens`, copy or parse `auth.json`, scrape browser state, import tokens, or reuse the user's global Codex home.
- Codex owns and refreshes ChatGPT credentials. Orcode stores only non-secret connection metadata and a keyed account fingerprint. Tokens, cookies, raw email, raw account/workspace payloads, device codes, verification URLs, and credential paths never enter config, events, logs, journals, exports, fixtures, or argv.
- The dedicated runtime home is resolved from opaque ID `codex-single` beneath `<appHome>/providers/codex/codex-single`. Every parent and child is canonical, owner-only, local, non-symlinked, and revalidated before launch. Configure `cli_auth_credentials_store = "keyring"`; plaintext credential-file fallback is unavailable.
- `--help` and `--version` perform zero app-home migration, Codex discovery, keyring access, process launch, or network calls. Ordinary startup inspects Codex only after the owner explicitly enables the connection.
- Default Codex inspection deadline is 5,000 ms, whole startup remains 8,000 ms, login wait is 10 minutes capped at 15 minutes/provider expiry, and drain is 5,000 ms before the complete process group or Job Object is terminated.
- A successful `account/read` alone is never ready. Readiness also requires a successful live, non-model `account/rateLimits/read` for the same runtime/home/account binding.
- Registration, login, inspection, model selection, and activation never imply task-execution readiness. Through Tasks 3–5, every Codex execution attempt returns typed `policy-unavailable` before prepared-view materialization, sandbox launch, thread creation, turn creation, or any task byte. Only Task 6 may publish `CodexExecutionReadiness { kind: "ready" }`, after the prepared view, supported sandbox, and durable managed-operation worker are bound together.
- Only `authMode: "chatgpt"` is accepted. `apikey`, externally managed tokens, personal access tokens, agent identity, Bedrock, null, and unknown future modes fail closed with zero task bytes sent.
- Only the exact observed normalized `planType: "pro"` uses `chatgpt-subscription-provider-managed-overage` in this Preview. Every other value, including `free`, other paid-looking strings, missing, null, and unknown future values, uses `chatgpt-account-provider-managed-limits`; neither realm is `plan-only`, and neither classification enables handoff.
- Managed Codex never receives the live workspace path. It receives an immutable `PreparedWorkspaceView` containing only canonical in-scope regular files, safe project instructions, and explicit attachments.
- Prepared-view defaults are 20,000 files, 64 MiB aggregate, and 2 MiB per file; hard maxima are 100,000 files, 256 MiB aggregate, and 8 MiB per file. A limit hit is an explicit incomplete result and blocks a completeness claim.
- The runtime sandbox must enforce read access only to the prepared view and required runtime libraries, write access only to dedicated scratch/auth roots, and provider-auth/model network only. Hooks, plugins, MCP, auto-update, inherited API credentials, arbitrary child execution, live workspace access, and unrelated user files are blocked. An unsupported platform/runtime tuple makes Codex unavailable.
- Default policy requires ephemeral task execution and an inspectable isolated history root. If the allowlisted runtime writes task text to a provider-owned local history path or cannot be drained, Codex is unavailable under this plan.
- A managed worker may return assistant text, structured findings, or `PatchProposalV1`. A proposal is data, never permission. Only Orcode may validate and apply it under policy, approval, `WorkspaceWriterLease`, `WorkspaceTransactionManifestV1`, and `ChangeJournal`.
- Every provider operation has a stable `operationId` and durable state `prepared | sent | acknowledged | streaming | terminal | indeterminate`. Once task bytes may have been accepted, reconnect may query or reattach but never resend automatically.
- Cross remains off after connect, login, repair, restart, reconnect, model selection, and migration. This plan does not implement multi-model collaboration.
- Preserve the untracked `.superpowers/brainstorm/` directory; never stage, delete, or rewrite it.

## File Structure

**Create**

- `src/codex-home.ts` — opaque single-home resolution, canonical/private checks, minimal config, and keyring-only credential-store policy.
- `src/codex-app-server.ts` — framed JSON-RPC lifecycle, typed official account/login/rate-limit/thread/turn/logout methods, deadlines, and process drain.
- `src/backend-codex.ts` — single-profile `BackendAdapter`, account fingerprint/realm reduction, model discovery, and managed worker factory.
- `src/prepared-workspace.ts` — immutable manifest and canonical safe-file materialization.
- `src/managed-runtime-sandbox.ts` — platform probe, launch policy, process-group/Job-Object ownership, network/filesystem restrictions, and unavailable result.
- `src/managed-operation.ts` — durable operation journal and no-blind-resend reconciliation.
- `src/patch-proposal.ts` — proposal validation and normalized operation set.
- `src/workspace-transaction.ts` — durable staging/stash manifest, fault-safe apply/rollback/finalize, and `ChangeJournal` commit.
- `tests/codex-home.test.ts`
- `tests/codex-app-server.test.ts`
- `tests/backend-codex.test.ts`
- `tests/prepared-workspace.test.ts`
- `tests/managed-runtime-sandbox.test.ts`
- `tests/managed-operation.test.ts`
- `tests/patch-proposal.test.ts`
- `tests/workspace-transaction.test.ts`
- `tests/codex-preview-integration.test.ts`
- `tests/codex-preview-privacy.test.ts`
- `tests/fixtures/fake-codex-app-server.mjs`
- `tests/fixtures/malicious-managed-runtime.mjs`
- `scripts/check-codex-preview-smoke.mjs`

**Modify**

- `src/backends.ts` — permit one Preview Codex adapter after removing the Slice-1 reservation; add managed-worker/result contracts.
- `src/provider-state.ts` — migrate provider setup schema v2 to v3 with backend-specific `credentialBinding` and exactly one `codex-single` connection; retain the explicit v1-to-v2-to-v3 compatibility path.
- `src/provider-authority.ts`, `src/provider-activation.ts`, `src/session.ts`, `src/cli.ts` — consume V3 through one validated keychain-binding accessor while keeping keychain journal V2 and legacy session behavior exact; provider-runtime bindings never enter credential authority.
- `src/provider-activation.ts` — activate/quarantine an opaque Codex home binding under the existing lease/generation boundary.
- `src/setup.ts` — connect/login/model-select/activate the Codex candidate without weakening startup deadlines or generation fencing.
- `src/setup-ui.ts` — secure browser/device-code presentation and exact single-profile Preview copy.
- `src/config.ts` — preserve future/corrupt schema refusal while persisting provider-state v3.
- `src/private-store.ts` — expose only identity-bound directory/file operations needed by the Codex home and transaction staging.
- `src/workspace.ts` — export one canonical safe-file enumerator and writer-lease seam; keep one security implementation.
- `src/cli.ts` — register the Codex adapter, run startup inspection only when enabled, and bind the managed worker.
- `src/commands.ts` — support connect/status/models/reconnect/disable/logout for `codex`; no profile or handoff commands.
- `src/command-catalog.ts` — document the Codex Preview commands and owner-only boundary.
- `src/redaction.ts` — classify Codex account/login/protocol fields and managed-runtime output.
- `src/storage.ts` — register managed-operation and workspace-transaction artifacts with exact retention classes.
- `src/types.ts` — add managed-operation/process events without provider payloads.
- `README.md` — generated command table plus truthful Preview, isolated-home, provider-history, and unsupported-platform copy.
- `tests/backends.test.ts`
- `tests/provider-state.test.ts`
- `tests/provider-activation.test.ts`
- `tests/setup.test.ts`
- `tests/setup-ui.test.ts`
- `tests/config.test.ts`
- `tests/private-store.test.ts`
- `tests/private-store-identity-races.test.ts`
- `tests/workspace.test.ts`
- `tests/cli.test.ts`
- `tests/cli-entrypoint.test.ts`
- `tests/commands.test.ts`
- `tests/commands-catalog.test.ts`
- `tests/redaction.test.ts`
- `tests/tui.test.ts`
- `tests/provider-privacy.test.ts`

---

### Task 1: Single Codex Home and Provider-State v3 Boundary

**Files:**
- Create: `src/codex-home.ts`
- Create: `tests/codex-home.test.ts`
- Modify: `src/provider-state.ts`
- Modify: `src/config.ts`
- Modify: `src/provider-authority.ts`
- Modify: `src/provider-activation.ts`
- Modify: `src/session.ts`
- Modify: `src/cli.ts`
- Test: `tests/provider-state.test.ts`
- Test: `tests/config.test.ts`
- Test: `tests/provider-authority.test.ts`
- Test: `tests/provider-activation.test.ts`
- Test: `tests/session.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `PrivateStore`, canonical app-home identity, Kimi-plan `ProviderSetupStateV2`, canonical OpenRouter/Kimi credential-slot pointers, and opaque connection ID `codex-single`.
- Produces: `CodexHomeBindingV1`, `CodexHomeStore.resolve(binding)`, `CodexHomeStore.prepare(binding)`, `ProviderSetupStateV3`, and the v2-to-v3 migration while preserving the existing explicit v1-to-v2-to-v3 read path.

- [ ] **Step 1: Write the failing home and schema tests**

Pin these contracts in tests:

```ts
export interface CodexHomeBindingV1 {
  version: 1;
  homeId: "codex-single";
  credentialStore: "keyring";
}

export type ProviderCredentialBindingV1 =
  | { kind: "orcode-keychain"; pointer: string }
  | { kind: "provider-runtime"; homeId: "codex-single" };

export interface ProviderConnectionStateV3
  extends Omit<ProviderConnectionStateV2, "credentialSlot"> {
  /** Exact compatibility projection: keychain pointer or null for provider runtime. */
  credentialSlot: string | null;
  credentialBinding: ProviderCredentialBindingV1;
}

export interface ProviderSetupStateV3
  extends Omit<ProviderSetupStateV2, "schemaVersion" | "connections"> {
  schemaVersion: 3;
  connections: ProviderConnectionStateV3[];
}
```

Assert that `resolve()` always returns `<appHome>/providers/codex/codex-single`, refuses a symlinked/swapped/network root, writes a minimal `config.toml` with `cli_auth_credentials_store = "keyring"`, and never returns the user's ambient `CODEX_HOME`. Assert schema v2 OpenRouter/Kimi state migrates byte-equivalently except for `schemaVersion: 3` and the addition of `{ kind: "orcode-keychain", pointer: credentialSlot }`; the validated `credentialSlot` remains as an exact compatibility projection. Provider-runtime connections require `credentialSlot: null`. Assert a schema-v1 fixture follows the already-tested v1-to-v2 migration and then produces the same canonical v3 bytes; a second v3 read is byte-identical. Reject binding/projection mismatches, a second Codex connection, a foreign home ID, a Codex connection with an Orcode keychain pointer, an OpenRouter/Kimi connection with a provider-runtime home, corrupt v2 pointers, and future schema 4. Run the existing authority, activation-journal, CLI, and legacy-session fixtures against migrated V3 state; keychain journals remain slot-shaped and provider-runtime bindings must fail before credential/journal access.

- [ ] **Step 2: Run the focused tests and observe RED**

```bash
node --import tsx --test tests/codex-home.test.ts tests/provider-state.test.ts tests/config.test.ts tests/provider-authority.test.ts tests/provider-activation.test.ts tests/session.test.ts tests/cli.test.ts
```

Expected: FAIL because `codex-home.ts`, schema v3, and backend-specific bindings do not exist.

- [ ] **Step 3: Implement opaque home resolution and the one-way schema migration**

Implement `CodexHomeStore` with constructor `{ appHome, privateStore, localFilesystemProbe }`, `resolve(binding): string`, `prepare(binding): Promise<{ home: string; configDigest: string }>`, and `assertLaunchable(binding): Promise<void>`. The public state stores only `homeId`; absolute paths stay inside the resolver. Add one `providerKeychainPointer(connection): string | null` accessor that validates `credentialBinding` against the compatibility projection. Migrate all authority, activation, CLI, and session consumers to this accessor in the same task; the existing activation journal remains keychain-only and rejects a provider-runtime binding. Preserve unknown-future and corrupt-state refusal and do not rewrite state during `--help`/`--version`.

- [ ] **Step 4: Run focused tests and type checks**

```bash
node --import tsx --test tests/codex-home.test.ts tests/provider-state.test.ts tests/config.test.ts tests/provider-authority.test.ts tests/provider-activation.test.ts tests/session.test.ts tests/cli.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm run check
```

Expected: all tests PASS and both TypeScript commands exit 0.

- [ ] **Step 5: Commit the single-home boundary**

```bash
git add src/codex-home.ts src/provider-state.ts src/config.ts src/provider-authority.ts src/provider-activation.ts src/session.ts src/cli.ts tests/codex-home.test.ts tests/provider-state.test.ts tests/config.test.ts tests/provider-authority.test.ts tests/provider-activation.test.ts tests/session.test.ts tests/cli.test.ts
git commit -m "feat: add isolated single Codex home"
```

---

### Task 2: Official App-Server Protocol, Login, and Account Classification

**Files:**
- Create: `src/codex-app-server.ts`
- Create: `tests/codex-app-server.test.ts`
- Create: `tests/fixtures/fake-codex-app-server.mjs`
- Modify: `src/redaction.ts`
- Test: `tests/redaction.test.ts`

**Interfaces:**
- Consumes: supported executable range, `CodexHomeStore`, absolute deadline, `AbortSignal`, scrubbed environment, and app-server newline-delimited JSON-RPC.
- Produces: `CodexAppServerClient`, `CodexLoginAttempt`, `CodexAccountObservation`, `CodexRateLimitObservation`, `CodexThreadHandle`, `CodexTurnHandle`, and `drain()`.

- [ ] **Step 1: Write the failing protocol matrix**

Use these exact safe types:

```ts
export interface CodexAccountObservation {
  authMode: "chatgpt" | "unsupported" | "logged-out";
  accountBinding: { scheme: "email-hmac-v1"; digest: string; strength: "derived" } | null;
  planType: string | null;
  workspaceClass: string | null;
  workspaceBindingDigest: string | null;
}

export interface CodexRateLimitObservation {
  class: "available" | "approaching-limit" | "limit-reached" | "unknown";
  bucketId: string | null;
  resetAt: number | null;
  observedAt: number;
}
```

The fake server must cover initialize, account read, live rate-limit read, browser/device login, exact-ID cancellation, malformed frames, unknown protocol versions, process exit, timeout, late success after cancel, thread/turn terminal events, logout, and drain. Assert raw email is HMACed and discarded before returning, `account/read` with email plus `planType` but no workspace fields preserves `workspaceClass: null`, and no fixture contains a real credential.

- [ ] **Step 2: Run the protocol tests and observe RED**

```bash
node --import tsx --test tests/codex-app-server.test.ts tests/redaction.test.ts
```

Expected: FAIL because the client and protocol fixture do not exist.

- [ ] **Step 3: Implement one owner of JSON-RPC and child lifecycle**

`CodexAppServerClient.start()` resolves and pins the executable identity, launches with `shell: false`, `CODEX_HOME` set to the dedicated home, no ambient API/token/plugin/MCP variables, and one owned process group or Job Object. `login()` stores the exact returned `loginId`; `cancelLogin(loginId)` waits for a terminal notification and then drains. Unknown methods, duplicate response IDs, invalid state transitions, or frames larger than the documented local cap terminate as `protocol-incompatible`. Never log raw frames.

- [ ] **Step 4: Run protocol, privacy, and type checks**

```bash
node --import tsx --test tests/codex-app-server.test.ts tests/redaction.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm run check
```

Expected: PASS with deterministic cancellation and zero raw account/login fields in snapshots.

- [ ] **Step 5: Commit the official protocol seam**

```bash
git add src/codex-app-server.ts src/redaction.ts tests/codex-app-server.test.ts tests/redaction.test.ts tests/fixtures/fake-codex-app-server.mjs
git commit -m "feat: add bounded Codex app-server client"
```

---

### Task 3: Single-Profile Codex Backend and Setup Integration

**Files:**
- Create: `src/backend-codex.ts`
- Create: `tests/backend-codex.test.ts`
- Modify: `src/backends.ts`
- Modify: `src/provider-activation.ts`
- Modify: `src/setup.ts`
- Modify: `src/setup-ui.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands.ts`
- Modify: `src/command-catalog.ts`
- Modify: `README.md`
- Test: `tests/backends.test.ts`
- Test: `tests/provider-activation.test.ts`
- Test: `tests/setup.test.ts`
- Test: `tests/setup-ui.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/commands.test.ts`
- Test: `tests/commands-catalog.test.ts`

**Interfaces:**
- Consumes: `BackendAdapter`, `CodexAppServerClient`, `CodexHomeBindingV1`, `ProviderActivationCoordinator`, and `SetupOrchestrator` generation/deadline contracts.
- Produces: `CodexBackendAdapter`, `CODEX_SINGLE_CONNECTION_ID`, `CodexRealmConsentV1`, `CodexExecutionReadiness`, and a Preview registry entry with one connection. In this task readiness can only be `{ kind: "policy-unavailable", reason: "managed-worker-missing" }`.

- [ ] **Step 1: Write the failing backend/setup tests**

Assert missing/impostor/unsupported runtime, logged out, cancelled login, live-check failure, offline, exact `pro`, `free`, other paid-looking strings, null, and future plan values, account/realm change, reconnect, disable, and confirmed logout. Pin `CODEX_SINGLE_CONNECTION_ID = "codex-single"`; registry construction must allow exactly this Codex adapter while rejecting duplicates. Verify the observed 0.142.5-shaped account `{ email, planType: "pro" }` produces an ordinary single-profile subscription-realm route but `workspaceClass: null`, while every non-`pro` value uses the account-managed realm; no value exposes a handoff/profile-selection action. Attempt text, finding, and patch execution through every plain/TUI/JSON route and assert typed `policy-unavailable`, zero prepared-view reads, zero sandbox launches, zero `thread/start`, zero `turn/start`, and zero task bytes. Change the command catalog, regenerate README through the existing renderer, and assert `tests/commands-catalog.test.ts` accepts the exact generated bytes.

- [ ] **Step 2: Run the backend/setup matrix and observe RED**

```bash
node --import tsx --test tests/backends.test.ts tests/backend-codex.test.ts tests/provider-activation.test.ts tests/setup.test.ts tests/setup-ui.test.ts tests/cli.test.ts tests/commands.test.ts tests/commands-catalog.test.ts
```

Expected: FAIL because Codex is still reserved by Slice 1 and no adapter exists.

- [ ] **Step 3: Implement the adapter and candidate activation**

Use one literal realm reducer—no case folding, substring match, or paid-plan inference:

```ts
export function classifyCodexBillingRealm(
  planType: string | null,
): "chatgpt-subscription-provider-managed-overage" | "chatgpt-account-provider-managed-limits" {
  return planType === "pro"
    ? "chatgpt-subscription-provider-managed-overage"
    : "chatgpt-account-provider-managed-limits";
}
```

`inspect()` performs executable/version, `account/read`, and live `account/rateLimits/read` only. `connect()` starts official login after explicit owner action. `listModels()` returns only documented canonical models from the exact authenticated runtime. `activate()` rechecks auth mode, account fingerprint, realm, selected model, home identity, and provider-state generation before the existing atomic pointer commit. `disconnect` remains an alias of disable; reconnect never logs in; logout is always-ask/no-remember and drains first. Register only setup/status/model lifecycle capabilities. The execution entry point consumes `CodexExecutionReadiness`; until Task 6 it returns fixed `policy-unavailable` synchronously before it can access a task envelope, prepared view, sandbox, app-server thread, or turn. Update generated README bytes in this task so the command catalog remains single-sourced and the repository is independently green.

- [ ] **Step 4: Run backend/setup tests and type checks**

```bash
node --import tsx --test tests/backends.test.ts tests/backend-codex.test.ts tests/provider-activation.test.ts tests/setup.test.ts tests/setup-ui.test.ts tests/cli.test.ts tests/commands.test.ts tests/commands-catalog.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm run check
```

Expected: PASS; startup contacts Codex only when enabled and never starts a thread.

- [ ] **Step 5: Commit the single-profile provider path**

```bash
git add src/backends.ts src/backend-codex.ts src/provider-activation.ts src/setup.ts src/setup-ui.ts src/cli.ts src/commands.ts src/command-catalog.ts README.md tests/backends.test.ts tests/backend-codex.test.ts tests/provider-activation.test.ts tests/setup.test.ts tests/setup-ui.test.ts tests/cli.test.ts tests/commands.test.ts tests/commands-catalog.test.ts
git commit -m "feat: connect one Codex Preview profile"
```

---

### Task 4: Immutable Prepared Workspace View

**Files:**
- Create: `src/prepared-workspace.ts`
- Create: `tests/prepared-workspace.test.ts`
- Modify: `src/workspace.ts`
- Modify: `src/private-store.ts`
- Test: `tests/workspace.test.ts`
- Test: `tests/private-store.test.ts`
- Test: `tests/private-store-identity-races.test.ts`

**Interfaces:**
- Consumes: canonical workspace root, exported `enumerateCanonicalSafeFiles()`, safe project-instruction paths, explicit attachment identities, and `PrivateStore`.
- Produces: `PreparedWorkspaceViewV1`, `PreparedWorkspaceManifestV1`, `prepareWorkspaceView(request)`, and `verifyPreparedWorkspaceView(view)`.
- Does not wire the view into `CodexBackendAdapter`; the Task 3 `managed-worker-missing` execution fence remains authoritative and `npm run check` must preserve zero task bytes.

- [ ] **Step 1: Write adversarial failing fixtures**

Pin the manifest:

```ts
export interface PreparedWorkspaceManifestV1 {
  version: 1;
  viewId: string;
  workspaceRootDigest: string;
  rootRevision: string;
  complete: boolean;
  omissionReasons: readonly string[];
  files: readonly { path: string; sourceHash: string; copiedHash: string; size: number }[];
  totalBytes: number;
}
```

Tests must reject `.env*`, `.git/**`, `node_modules/**`, protected paths, ignored files, links, hard-linked aliases, sockets/devices, binary secrets, canonical/case-fold collisions, identity swaps, attachment escape, and changed bytes between scan/copy/hash. At each default and hard maximum, assert exact at-limit success and one-over visible incompleteness.

- [ ] **Step 2: Run prepared-view tests and observe RED**

```bash
node --import tsx --test tests/prepared-workspace.test.ts tests/workspace.test.ts tests/private-store-identity-races.test.ts
```

Expected: FAIL because the canonical enumerator and prepared-view module do not exist.

- [ ] **Step 3: Implement one canonical enumeration/copy pipeline**

Extract the safe file-enumeration policy from the existing built-in workspace search instead of creating a second ignore/security implementation. Open and hash each regular file through identity-checked handles, materialize into a private view root, make copied content immutable before publication, fsync manifest and tree, and verify every copied hash before returning. Do not include the absolute live workspace path in the provider prompt or manifest delivered to Codex.

- [ ] **Step 4: Run adversarial and type checks**

```bash
node --import tsx --test tests/prepared-workspace.test.ts tests/workspace.test.ts tests/private-store.test.ts tests/private-store-identity-races.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm run check
```

Expected: PASS; fake `rg` presence does not change the view.

- [ ] **Step 5: Commit the prepared-view boundary**

```bash
git add src/prepared-workspace.ts src/workspace.ts src/private-store.ts tests/prepared-workspace.test.ts tests/workspace.test.ts tests/private-store.test.ts tests/private-store-identity-races.test.ts
git commit -m "feat: prepare immutable managed workspace views"
```

---

### Task 5: OS-Enforced Managed Runtime Sandbox

**Files:**
- Create: `src/managed-runtime-sandbox.ts`
- Create: `tests/managed-runtime-sandbox.test.ts`
- Create: `tests/fixtures/malicious-managed-runtime.mjs`
- Modify: `src/backend-codex.ts`
- Test: `tests/backend-codex.test.ts`
- Test: `tests/provider-privacy.test.ts`

**Interfaces:**
- Consumes: exact executable identity/version, prepared-view root, scratch/auth roots, provider endpoint allowlist, resource ceilings, deadline, and `AbortSignal`.
- Produces: `ManagedRuntimeSandbox.probe(request): Promise<SandboxSupport>`, `launch(request): Promise<ManagedRuntimeProcess>`, and typed unavailable reasons.
- May refine execution readiness to `policy-unavailable` with a sandbox reason, but cannot produce `{ kind: "ready" }`; the durable worker/journal does not exist until Task 6.

- [ ] **Step 1: Write the malicious-runtime RED matrix**

Use exact support output:

```ts
export type SandboxSupport =
  | { kind: "supported"; platform: NodeJS.Platform; mechanism: string; proofVersion: 1 }
  | { kind: "unavailable"; reason: "missing-os-boundary" | "unsupported-runtime" | "network-policy-unavailable" | "history-root-uninspectable" };
```

The malicious fixture attempts live-workspace and home reads/writes, symlink escape, plugin/hook/MCP loading, arbitrary child spawn, foreign network, inherited key access, local task-history persistence, and an orphan after cancellation. Unsupported mechanisms must return `unavailable` before app-server launch; they may not downgrade to a reviewer-only mode. Even a supported probe must leave text/finding/patch execution `policy-unavailable` with zero `thread/start`, `turn/start`, and task bytes because Task 6 has not installed the durable worker.

- [ ] **Step 2: Run sandbox tests and observe RED**

```bash
node --import tsx --test tests/managed-runtime-sandbox.test.ts tests/backend-codex.test.ts
```

Expected: FAIL because no sandbox boundary exists.

- [ ] **Step 3: Implement platform adapters with fail-closed probing**

Launch only through a tested OS boundary for the exact tuple. The adapter owns the complete POSIX process group or Windows Job Object, uses a minimal environment, disables auto-update/hooks/plugins/MCP, denies live-workspace/unrelated-user paths, and restricts runtime network to the versioned provider endpoint allowlist. Inspect the adapter-declared local history roots after normal exit and forced crash; a sentinel task string must be absent. If any control cannot be established, return `unavailable` and do not spawn Codex.

- [ ] **Step 4: Run sandbox and privacy checks**

```bash
node --import tsx --test tests/managed-runtime-sandbox.test.ts tests/backend-codex.test.ts tests/provider-privacy.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm run check
```

Expected: PASS in deterministic adapters; live platform support remains separately gated by Task 8.

- [ ] **Step 5: Commit the runtime sandbox**

```bash
git add src/managed-runtime-sandbox.ts src/backend-codex.ts tests/managed-runtime-sandbox.test.ts tests/backend-codex.test.ts tests/provider-privacy.test.ts tests/fixtures/malicious-managed-runtime.mjs
git commit -m "feat: enforce managed Codex runtime sandbox"
```

---

### Task 6: Durable Managed Operation Journal and Worker

**Files:**
- Create: `src/patch-proposal.ts`
- Create: `tests/patch-proposal.test.ts`
- Create: `src/managed-operation.ts`
- Create: `tests/managed-operation.test.ts`
- Modify: `src/backend-codex.ts`
- Modify: `src/storage.ts`
- Modify: `src/types.ts`
- Test: `tests/backend-codex.test.ts`

**Interfaces:**
- Consumes: sandboxed app-server, prepared view, canonical task envelope, exact route/model, budgets, and `PrivateStore`.
- Produces: `PatchProposalV1`, `validatePatchProposal()`, `ManagedOperationJournalV1`, `ManagedOperationCoordinator`, `ManagedWorker`, `ManagedWorkerResult`, and the only transition of `CodexExecutionReadiness` to `{ kind: "ready"; worker }` after all prerequisites validate for the exact route/platform/runtime tuple.

- [ ] **Step 1: Write state-machine and crash RED tests**

Pin these states and result union:

```ts
export type ManagedOperationState = "prepared" | "sent" | "acknowledged" | "streaming" | "terminal" | "indeterminate";
export interface PatchProposalV1 {
  version: 1;
  proposalId: string;
  sourceRunId: string;
  sourceTaskId: string;
  baseWorkspaceRevision: string;
  operations: readonly (
    | { kind: "create"; path: string; content: string }
    | { kind: "update"; path: string; expectedHash: string; content: string }
    | { kind: "rename"; from: string; to: string; expectedHash: string }
    | { kind: "delete"; path: string; expectedHash: string }
  )[];
}
export type ManagedWorkerResult =
  | { kind: "text"; text: string }
  | { kind: "findings"; findings: readonly { severity: string; message: string; path?: string }[] }
  | { kind: "patch"; proposal: PatchProposalV1 };
```

Fault-inject before/after durable preparation, first task byte, provider acknowledgment, stream chunk, terminal event, late usage, and journal fsync. Assert automatic retry is allowed only from `prepared` after transport proves zero accepted task bytes. Sent/acknowledged/streaming/unknown crash states reconcile or become `indeterminate`; they never resend. Proposal tests reject duplicate/case-fold-colliding paths, aliases, rename cycles, overlapping operations, absolute/escaping/protected paths, malformed hashes, and unbounded content before a worker result crosses the adapter boundary. Table-drive each missing prepared-view/sandbox/journal/route/account prerequisite and prove readiness remains `policy-unavailable` with zero task bytes; only one complete exact tuple can publish `ready`.

- [ ] **Step 2: Run operation tests and observe RED**

```bash
node --import tsx --test tests/patch-proposal.test.ts tests/managed-operation.test.ts tests/backend-codex.test.ts
```

Expected: FAIL because the journal/coordinator do not exist.

- [ ] **Step 3: Implement durable operation ownership**

Implement `PatchProposalV1` parsing and full canonical operation-set validation before exposing a patch result. Persist one journal per `operationId` through `PrivateStore`, fsync every authority transition, deduplicate terminal and late-usage events, and record only safe hashes/IDs. Publish `CodexExecutionReadiness { kind: "ready", worker }` atomically only after the exact route/account, verified complete prepared view, supported sandbox proof, journal authority, and worker binding are present; any loss immediately returns to `policy-unavailable`. `ManagedWorker.run()` revalidates the same tuple immediately before first task bytes, opens one ephemeral task thread, streams typed results, drains the runtime, inspects history roots, and closes the empty/bootstrap thread if the supported protocol requires one.

- [ ] **Step 4: Run operation, backend, and type checks**

```bash
node --import tsx --test tests/patch-proposal.test.ts tests/managed-operation.test.ts tests/backend-codex.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm run check
```

Expected: PASS with no duplicate sends across every injected crash point.

- [ ] **Step 5: Commit managed operation semantics**

```bash
git add src/patch-proposal.ts src/managed-operation.ts src/backend-codex.ts src/storage.ts src/types.ts tests/patch-proposal.test.ts tests/managed-operation.test.ts tests/backend-codex.test.ts
git commit -m "feat: journal managed Codex operations"
```

---

### Task 7: Patch Proposal Validation and Workspace Transaction

**Files:**
- Create: `src/workspace-transaction.ts`
- Create: `tests/workspace-transaction.test.ts`
- Modify: `src/workspace.ts`
- Modify: `src/storage.ts`

**Interfaces:**
- Consumes: validated `PatchProposalV1` from Task 6, current workspace revision, `WorkspaceGuard`, central policy/approval, writer lease, `PrivateStore`, and `ChangeJournal`.
- Produces: `WorkspaceTransactionManifestV1`, `WorkspaceTransactionCoordinator.apply()`, and `recoverWorkspaceTransactions()`.

- [ ] **Step 1: Write proposal/transaction RED tests**

Cover hardlinks, symlinks and identity swaps, stale base/preimage hashes, approval denial, writer contention, and fault injection after each staging/manifest/stash/replace/rename/delete/fsync/journal boundary. Re-run Task 6's operation-set validator at effect time before creating transaction artifacts. Pre-commit failure changes no target file; interruption after commit begins blocks new workspace use until rollback/finalize.

- [ ] **Step 2: Run transaction tests and observe RED**

```bash
node --import tsx --test tests/workspace-transaction.test.ts tests/workspace.test.ts
```

Expected: FAIL because proposal and durable transaction modules do not exist.

- [ ] **Step 3: Implement central validation and idempotent recovery**

Validate the entire canonical source/destination set before creating artifacts. Stage after-content and every preimage inside a declared user-only workspace-filesystem transaction root protected from search/model/Git presentation. Fsync content before `prepared`; move deletes to stash; advance an idempotent phase per operation; fsync workspace and `ChangeJournal` before `committed`. Startup recovers `applying` by safe rollback or verifies/finalizes `committed`; unexplained outside drift produces exact `workspace-recovery-required` and blocks runs.

- [ ] **Step 4: Run transaction and type checks**

```bash
node --import tsx --test tests/workspace-transaction.test.ts tests/workspace.test.ts
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.tests.json --noEmit
npm run check
```

Expected: PASS across every declared fault boundary.

- [ ] **Step 5: Commit patch application safety**

```bash
git add src/workspace-transaction.ts src/workspace.ts src/storage.ts tests/workspace-transaction.test.ts tests/workspace.test.ts
git commit -m "feat: apply managed patch proposals safely"
```

---

### Task 8: End-to-End Preview Surface and Release Gate

**Files:**
- Create: `tests/codex-preview-integration.test.ts`
- Create: `tests/codex-preview-privacy.test.ts`
- Create: `scripts/check-codex-preview-smoke.mjs`
- Modify: `src/cli.ts`
- Modify: `src/commands.ts`
- Modify: `src/setup-ui.ts`
- Modify: `src/tui.ts`
- Modify: `README.md`
- Test: `tests/cli-entrypoint.test.ts`
- Test: `tests/tui.test.ts`
- Test: `tests/provider-privacy.test.ts`

**Interfaces:**
- Consumes: Tasks 1-7 and the existing plain/fullscreen/non-interactive provider surfaces.
- Produces: one owner-visible Codex Preview route with text/finding/patch outcomes and a platform/version smoke record; no handoff surface.

- [ ] **Step 1: Write end-to-end RED tests**

Exercise explicit connect, browser/device login, model selection, startup reuse, text response, patch review/apply, cancellation, reconnect, disable, logout, offline startup, realm change, indeterminate operation, and crash recovery. Assert Cross remains false; `provider profiles`, any second Codex connect, `handoff`, automatic target selection, and collaborator dispatch are unavailable. Scan UI, logs, config, journals, temp roots, crash output, and fixtures for synthetic raw email/token/device-code fragments.

- [ ] **Step 2: Run the end-to-end suite and observe RED**

```bash
node --import tsx --test tests/codex-preview-integration.test.ts tests/codex-preview-privacy.test.ts tests/cli-entrypoint.test.ts tests/tui.test.ts tests/provider-privacy.test.ts
```

Expected before final wiring: at least managed-worker binding, patch review, and no-handoff command assertions FAIL.

- [ ] **Step 3: Wire the surfaces and truthful documentation**

Show `ChatGPT über Codex · Preview`, exact account realm, sandbox/history availability, and normalized usage only in the owner surface. Explain that 0.142.5 currently supplies email plus `planType` but not the workspace fact required by the separate owner-handoff design, so this release is one manual single-profile route only. Generate command documentation from `CommandCatalog`; do not add a hand-written competing table.

- [ ] **Step 4: Run deterministic, full, package, and live-gate commands**

```bash
node --import tsx --test tests/codex-preview-integration.test.ts tests/codex-preview-privacy.test.ts tests/cli-entrypoint.test.ts tests/tui.test.ts tests/provider-privacy.test.ts
npm run check
npm run build
npm run check:package
npm run check:release -- --tag v0.4.1
node scripts/check-codex-preview-smoke.mjs --runtime-range 0.142.5 --normal-exit --forced-crash
```

Run package and release-metadata checks serially. The explicit `v0.4.1` validates the current branch metadata only; it creates no tag, publishes nothing, and must be amended only with a separately approved version change. Expected: deterministic/full/package checks PASS. The smoke script records PASS only for exact OS/runtime tuples that prove authenticated login, keyring-only isolation, sandbox containment, no local task-history sentinel, complete drain, and no credential capture. Any failed live condition leaves Codex Preview unavailable on that tuple and must not be represented as release support; a macOS result is not Windows evidence.

- [ ] **Step 5: Commit the single-profile Preview gate**

```bash
git add src/cli.ts src/commands.ts src/setup-ui.ts src/tui.ts README.md tests/codex-preview-integration.test.ts tests/codex-preview-privacy.test.ts tests/cli-entrypoint.test.ts tests/tui.test.ts tests/provider-privacy.test.ts scripts/check-codex-preview-smoke.mjs
git commit -m "feat: gate Codex single-profile Preview"
```

## Completion Gate

- The implementation is complete only when Tasks 1-8 are committed in order, all deterministic checks are green, and at least one exact OS/Codex tuple has a fresh authenticated normal-exit and forced-crash smoke with sanitized evidence.
- Passing fake-runtime tests does not advertise live Codex support. A tuple without proven keyring, sandbox, provider-history, and process-drain boundaries stays `policy-unavailable`.
- Successful completion enables one explicit owner-only Codex route. It does not unblock owner subscription handoff: Codex 0.142.5 still lacks the required fresh exact workspace classification/workspace binding, and this plan introduces no multi-profile machinery.
