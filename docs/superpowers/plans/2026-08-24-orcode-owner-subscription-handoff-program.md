# Orcode Owner Subscription Handoff Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the owner-only manual subscription-handoff design as six sequential, independently reviewable child plans while keeping dispatch unavailable until identity, isolation, compliance, replay safety, UX, and live provider gates all pass together.

**Architecture:** Build immutable principal/provenance authority first, then isolated owner profiles, then an authenticated deny-by-default policy and typed exhaustion classifier, then a zero-redispatch effect ledger plus encrypted continuation checkpoint, and only then the coordinator/UX. The final child plan is a release gate, not a feature-enabling shortcut: it may publish an allow decision only for an exact supported runtime/platform/region/plan/workspace tuple after current legal/provider review and black-box evidence.

**Tech Stack:** Node.js 22, TypeScript 5.9, `node:test`, official allowlisted `codex app-server`, existing `PrivateStore` and OS keyring, versioned Orcode core/events/run journals; no token import/export and no new credential owner.

**Spec:** `docs/superpowers/specs/2026-08-24-orcode-owner-subscription-handoff-design.md`

## Global Constraints

- The feature is manual **owner subscription handoff**, never a subscription pool, automatic rotation, automatic failover, round robin, quota optimizer, background continuation, or combined entitlement.
- Every transition that changes the provider profile requires one exact owner or enrolled owner-device confirmation. No timer, reset notification, health event, restart, focus, default button, model suggestion, or collaborator action can select or confirm a target.
- Collaborators are bring-your-own-provider only. They cannot enumerate owner profile count/labels/status, read account/quota state, decrypt checkpoints, mint grants, launch an owner Codex runtime, or dispatch through an owner subscription.
- Collaborator-originated input blocks owner-profile use unless the owner completed a separate content-bound adoption before the source turn. Adoption never appears inside an exhaustion/handoff prompt and cannot be added after exhaustion.
- A reached preflight creates no handoff checkpoint, target inspection, target network call, prompt, or grant. It offers only wait or ordinary manual route selection, whose call identity and authorization are separate.
- Handoff requires a terminal typed `UsageLimitExceeded` plus a fresh matching same-profile rate-limit observation. Generic 429, raw text, timeout, network loss, authentication failure, local budget, API credit, approaching limit, stale data, and indeterminate operations never qualify.
- Only the one failed logical provider call may receive a new `attempt_id`. Completed model calls, tools, approvals, tests, file effects, plan steps, and external effects are never rerun.
- Any failed-turn external effect blocks by default. The only allowed case has a durable canonical action digest, reusable cross-attempt idempotency identity, authenticated stored terminal result, `dispatch_count = 1`, and target replay that performs zero process/filesystem/network redispatch. YOLO is not an exception.
- Provider credentials, `auth.json`, raw tokens, cookies, emails, workspace/plan/quota payloads, login URLs/device codes, provider-owned session state, and hidden reasoning never enter profile metadata, checkpoints, grants, audit, logs, exports, fixtures, or argv.
- The documented headless `auth.json` copy seam and experimental `chatgptAuthTokens` mode are intentionally rejected. Every owner profile completes its own official Codex-managed browser/device-code login in an isolated Orcode-owned home with a proven independent keyring namespace.
- A named Codex `--profile` is configuration layering only; it is never accepted as authentication isolation.
- Source and target require fresh comparable `verified_opaque` or `derived` account bindings with distinct digests, exact approved `plan_class` and `workspace_class`, current owner-device attestations, current profile generations, and one exact policy evaluation immediately before first target bytes.
- The locally inspected `codex-cli 0.142.5` `account/read` result provides email and `planType` but no `workspace_class` or stable workspace ID. Therefore every handoff pair on that observed tuple enters state `blocked_plan_or_workspace` with normalized reason `missing_workspace_class`; no allow evaluation can be materialized, and the handoff UI/dispatch must remain unavailable. Do not infer workspace class from email, plan, home path, keyring entry, configuration profile, or rate-limit bucket.
- Missing, malformed, expired, future, revoked, wrong-region, wrong-version, wrong-plan/workspace, signature-invalid, or absent `ProviderHandoffPolicyV1` denies. No allow policy is bundled by these child plans.
- Policy expiry/revocation invalidates open grants and converts affected checkpoints to `blocked_policy_invalid_inspect_only`; a later policy cannot renew, rebound, or dispatch them.
- API-key billing is a separate route and separate consent. It is never represented as another subscription profile or selected by a handoff grant.
- Passing unit/simulated exhaustion tests does not establish provider permission, real subscription exhaustion, account ownership, keyring isolation, or release support.
- Preserve the untracked `.superpowers/brainstorm/` directory; never stage, delete, or rewrite it.

## Program Entry Gate

Execution may start only after all of these repository prerequisites exist and are green:

- `docs/superpowers/plans/2026-08-24-orcode-codex-single-profile-preview.md` is implemented, including isolated `CodexHomeStore`, official `CodexAppServerClient`, managed sandbox, `ManagedOperationJournalV1`, prepared workspace, and patch transaction gates.
- The 0.5 core boundary exists as `src/core.ts` and `src/events.ts` with versioned `CoreIntent`/`CoreEvent`, authenticated surface identity, and one central provider dispatch path.
- The 0.6 run boundary assigns stable `logical_task_id`, `logical_call_id`, and per-attempt IDs; drains tool/process/approval/writer activity; and never marks mutating work complete before verification.
- Existing OpenRouter/provider authority, provider state, private-store, crash-resume, `ChangeJournal`, redaction, and retention suites are green.

**Current program outcome:** BLOCKED. The present branch is the integrated Slice-1/OpenRouter foundation and does not yet contain the single-profile Codex Preview or 0.5/0.6 core/run prerequisites. Even after those are implemented, the observed Codex 0.142.5 account surface lacks the mandatory workspace fact, so release dispatch remains blocked.

## Child-Plan File Map

**Child Plan 1 — owner/device/provenance**

- Create: `src/principals.ts`, `src/input-provenance.ts`, `src/owner-adoption.ts`
- Modify: `src/core.ts`, `src/events.ts`, `src/session.ts`, `src/redaction.ts`, `src/storage.ts`
- Test: `tests/principals.test.ts`, `tests/input-provenance.test.ts`, `tests/owner-adoption.test.ts`, `tests/core-provenance.test.ts`

**Child Plan 2 — isolated profiles**

- Create: `src/secure-control-store.ts`, `src/subscription-profiles.ts`, `src/codex-profile-runtime.ts`, `src/profile-attestation.ts`, `src/owner-profile-route-authority.ts`
- Modify: `src/codex-home.ts`, `src/codex-app-server.ts`, `src/backend-codex.ts`, `src/setup.ts`, `src/commands.ts`
- Test: `tests/secure-control-store.test.ts`, `tests/subscription-profiles.test.ts`, `tests/codex-profile-runtime.test.ts`, `tests/profile-attestation.test.ts`, `tests/codex-profile-isolation.test.ts`, `tests/owner-profile-route-authority.test.ts`

**Child Plan 3 — signed policy and classifier**

- Create: `src/provider-handoff-policy.ts`, `src/subscription-limit-classifier.ts`
- Test: `tests/provider-handoff-policy.test.ts`, `tests/subscription-limit-classifier.test.ts`

**Child Plan 4 — effect ledger and checkpoint**

- Create: `src/effect-ledger.ts`, `src/handoff-crypto.ts`, `src/task-continuation.ts`, `src/handoff-operation-journal.ts`
- Modify: `src/core.ts`, `src/events.ts`, `src/storage.ts`, `src/private-store.ts`, `src/workspace.ts`, `src/runlog.ts`
- Test: `tests/effect-ledger.test.ts`, `tests/handoff-crypto.test.ts`, `tests/task-continuation.test.ts`, `tests/handoff-operation-journal.test.ts`

**Child Plan 5 — coordinator and UX**

- Create: `src/handoff-coordinator.ts`, `src/handoff-grant.ts`, `src/handoff-ui.ts`
- Modify: `src/core.ts`, `src/events.ts`, `src/cli.ts`, `src/commands.ts`, `src/command-catalog.ts`, `src/tui.ts`, `src/setup-ui.ts`, `src/redaction.ts`
- Test: `tests/handoff-coordinator.test.ts`, `tests/handoff-grant.test.ts`, `tests/handoff-ui.test.ts`, `tests/handoff-collaborator-abuse.test.ts`, `tests/handoff-pty.test.ts`

**Child Plan 6 — release gate**

- Create: `scripts/check-owner-handoff-contract.mjs`, `scripts/check-owner-handoff-isolation.mjs`, `scripts/check-owner-handoff-release.mjs`, `tests/owner-handoff-release.test.ts`, `docs/release/owner-handoff-policy-format.md`
- Modify: `package.json`, `README.md`, `docs/superpowers/specs/2026-08-24-orcode-owner-subscription-handoff-design.md` only for dated reviewed-reference metadata if the source documents changed; normative behavior changes require a new approved design.

---

### Child Plan 1: Owner, Device, and Immutable Input Provenance

**Dependencies:** Program Entry Gate only. This child plan does not read a subscription profile or start Codex.

**Files:**
- Create: `src/principals.ts`
- Create: `src/input-provenance.ts`
- Create: `src/owner-adoption.ts`
- Create: `tests/principals.test.ts`
- Create: `tests/input-provenance.test.ts`
- Create: `tests/owner-adoption.test.ts`
- Create: `tests/core-provenance.test.ts`
- Modify: `src/core.ts`
- Modify: `src/events.ts`
- Modify: `src/session.ts`
- Modify: `src/redaction.ts`
- Modify: `src/storage.ts`

**Interfaces:**
- Consumes: authenticated local/relay surface identity, canonical OS account identity, device-key signer, `CoreIntent`, chat/task/workspace identity, and ordered core event sequence.
- Produces: `AuthenticatedPrincipalV1`, `InputProvenanceV1`, `LogicalCallAuthorityV1`, `OwnerInputAdoptionV1`, `PrincipalAuthority`, `InputProvenanceStore`, and `OwnerAdoptionStore`.

```ts
export type PrincipalClass = "owner" | "owner_device" | "collaborator" | "executor";

export interface AuthenticatedPrincipalV1 {
  version: 1;
  principalId: string;
  principalClass: PrincipalClass;
  principalEpoch: number;
  capabilityEpoch: number;
  authenticatedChannelDigest: string;
  deviceBindingDigest: string | null;
}

export interface InputProvenanceV1 {
  version: 1;
  inputEventId: string;
  logicalTaskId: string;
  chatId: string;
  inputKind: "user" | "steer" | "attachment" | "remote_command";
  originatingPrincipalId: string;
  originatingPrincipalClass: "owner" | "owner_device" | "collaborator";
  principalEpoch: number;
  capabilityEpoch: number;
  authenticatedChannelAndDeviceBinding: string;
  contentDigest: string;
  attachmentDigests: readonly string[];
  receivedEventSequence: number;
  receivedAt: number;
  ownerAdoptionDigest: string | null;
}

export interface LogicalCallAuthorityV1 {
  version: 1;
  logicalCallId: string;
  originatingPrincipalId: string;
  originatingPrincipalClass: "owner" | "owner_device" | "collaborator";
  principalEpoch: number;
  capabilityEpoch: number;
  inputProvenanceRoot: string;
  inputProvenanceRecordRefs: readonly string[];
  ownerAdoptionDigests: readonly string[];
  providerHandoffPolicyDigest: string | null;
  authorityRecordGeneration: number;
}

export interface OwnerInputAdoptionV1 {
  version: 1;
  adoptionId: string;
  ownerId: string;
  ownerDeviceId: string;
  logicalTaskId: string;
  chatId: string;
  workspaceIdentity: string;
  inputEventIds: readonly string[];
  sourcePrincipalIds: readonly string[];
  sourcePrincipalEpochs: readonly number[];
  sourceCapabilityEpochs: readonly number[];
  contentDigests: readonly string[];
  attachmentDigests: readonly string[];
  policyRevision: number;
  adoptedAt: number;
  ownerSignature: string;
}
```

- [ ] **Step 1: Write failing principal/provenance/adoption tests**

Cover canonical UID/SID plus owner/device-key binding, device revocation/epoch bump, collaborator classification before dispatch, every input kind, ordered Merkle/root changes, compaction/import/fork/restart/relay preservation, later steering under a changed principal, and one-way append semantics. `OwnerInputAdoptionV1` must bind exact input IDs, content/attachment digests, source/owner epochs, task/chat/workspace identity, owner device, policy revision, and adoption time; altered bytes or post-source-turn adoption must reject.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/principals.test.ts tests/input-provenance.test.ts tests/owner-adoption.test.ts tests/core-provenance.test.ts
```

Expected: FAIL because the authority and provenance modules do not exist.

- [ ] **Step 3: Implement the authority-before-context boundary**

Authenticate and durably append provenance before any user/steer/attachment/remote command enters canonical task context. Make principal/capability epoch changes invalidate prepared logical-call authority. Redact content while preserving digests and source class. Owner adoption is a separate always-explicit owner action available only before a new ordinary owner call; it cannot be invoked by a handoff state or collaborator.

- [ ] **Step 4: Run GREEN and regression checks**

```bash
node --import tsx --test tests/principals.test.ts tests/input-provenance.test.ts tests/owner-adoption.test.ts tests/core-provenance.test.ts
npm run check
```

Expected: PASS with no provider/keyring/network calls in these suites.

- [ ] **Step 5: Commit Child Plan 1**

```bash
git add src/principals.ts src/input-provenance.ts src/owner-adoption.ts src/core.ts src/events.ts src/session.ts src/redaction.ts src/storage.ts tests/principals.test.ts tests/input-provenance.test.ts tests/owner-adoption.test.ts tests/core-provenance.test.ts
git commit -m "feat: bind calls to owner input provenance"
```

**Exit Gate / Outcome:** UNBLOCK Child Plan 2 only when every core input has immutable provenance and collaborator dispatch is denied before provider/profile effects. Handoff remains unavailable.

---

### Child Plan 2: Independently Isolated Owner Subscription Profiles

**Dependencies:** Child Plan 1 PASS and single-profile Codex Preview live on the exact platform/runtime tuple.

**Files:**
- Create: `src/secure-control-store.ts`
- Create: `src/subscription-profiles.ts`
- Create: `src/codex-profile-runtime.ts`
- Create: `src/profile-attestation.ts`
- Create: `src/owner-profile-route-authority.ts`
- Create: `tests/secure-control-store.test.ts`
- Create: `tests/subscription-profiles.test.ts`
- Create: `tests/codex-profile-runtime.test.ts`
- Create: `tests/profile-attestation.test.ts`
- Create: `tests/codex-profile-isolation.test.ts`
- Create: `tests/owner-profile-route-authority.test.ts`
- Modify: `src/codex-home.ts`
- Modify: `src/codex-app-server.ts`
- Modify: `src/backend-codex.ts`
- Modify: `src/setup.ts`
- Modify: `src/commands.ts`

**Interfaces:**
- Consumes: `AuthenticatedPrincipalV1`, official login/account/rate-limit/logout seams, protected per-device HMAC/signing keys, single-profile Codex runtime/sandbox contracts, and unchanged `ProviderSetupStateV3` with its one ordinary `codex-single` connection.
- Produces: `SecureControlStore`, `OwnerSubscriptionProfileV1`, encrypted `OwnerSubscriptionProfileStore`, `CodexProfileRuntimeFactory`, `OwnerProfileRouteAuthority`, `OwnerSubscriptionAttestationV1`, `ProfilePairEligibility`, and generation-CAS transitions.

```ts
export interface OwnerSubscriptionProfileV1 {
  version: 1;
  subscriptionProfileId: string;
  ownerId: string;
  executorDeviceId: string;
  profileGeneration: number;
  displayLabel: string;
  codexHomeBindingDigest: string;
  credentialNamespaceDigest: string;
  codexVersionRange: string;
  authMode: "chatgpt";
  accountBindingScheme: string | null;
  accountBindingDigest: string | null;
  accountBindingStrength: "verified_opaque" | "derived" | "profile_only";
  accountBindingObservationId: string | null;
  accountBindingObservedAt: number | null;
  planClass: string | null;
  workspaceClass: string | null;
  ownerAttestationDigest: string | null;
  ownerAttestationExpiresAt: number | null;
  state: "unenrolled" | "enrolling" | "ready" | "usage_exhausted" | "reauth_required" | "disabled" | "revoked";
  lastHealthClass: string;
  lastRateLimitClass: string;
  lastCheckedAt: number;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface OwnerSubscriptionAttestationV1 {
  version: 1;
  attestationId: string;
  ownerId: string;
  attestingDeviceId: string;
  subscriptionProfileId: string;
  accountBindingScheme: string;
  accountBindingDigest: string;
  accountBindingStrength: "verified_opaque" | "derived";
  planClass: string;
  workspaceClass: string;
  profileGeneration: number;
  principalEpoch: number;
  capabilityEpoch: number;
  attestedAt: number;
  expiresAt: number;
  attestationRevision: number;
  deviceSignatureOrMac: string;
}

export type ProfilePairEligibility =
  | { kind: "eligible"; evaluationInputsDigest: string }
  | { kind: "blocked"; reason: "missing_binding" | "profile_only" | "incomparable_binding" | "same_account" | "stale_binding" | "missing_plan_class" | "missing_workspace_class" | "unapproved_plan_or_workspace" | "stale_attestation" | "isolation_unproven" | "wrong_owner_or_executor" };
```

- [ ] **Step 1: Write failing profile/isolation/attestation tests**

Cover authenticated encryption and CAS for the separate profile store; tamper/truncation/key-loss/wrong-device refusal; two independent homes/keyring namespaces; A/B concurrent runtime routing; login/logoff/revoke/corrupt/replace ordering; wrong OS owner; shared/symlinked/network home; ambient global login/API keys; plaintext `auth.json`; account changes; equal/incomparable/stale bindings; exact plan/workspace fields; short-lived device-bound attestations; and collaborator enumeration attempts. Assert `ProviderSetupStateV3` remains byte-identical and still rejects a second/foreign ordinary Codex connection: multi-profile records live only in the encrypted control store and reach execution only through `OwnerProfileRouteAuthority`. Black-box isolation tests observe behavior and file/keyring metadata only; they never inspect token values.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/secure-control-store.test.ts tests/subscription-profiles.test.ts tests/codex-profile-runtime.test.ts tests/profile-attestation.test.ts tests/codex-profile-isolation.test.ts tests/owner-profile-route-authority.test.ts
```

Expected: FAIL because profile collection/isolation contracts do not exist.

- [ ] **Step 3: Implement isolated homes and pair derivation**

Keep the single-profile provider state at schema V3 and leave its `codex-single` connection semantics unchanged. `SecureControlStore` holds the per-device master key only in the OS keyring and publishes authenticated-encrypted profile records with generation CAS, atomic write/readback, and no plaintext fallback. Allocate opaque random profile IDs and one private home/keyring namespace per profile in that separate store. `OwnerProfileRouteAuthority` is the sole bridge from an authenticated owner intent plus exact profile generation to `CodexProfileRuntimeFactory`; it returns a secretless leased runtime and never publishes profile count, binding data, home path, or provider state to collaborator surfaces. Enroll only after explicit owner action; CAS every transition by `profileGeneration`; re-read source/target account, plan, workspace, runtime, and attestation immediately before any pair result. Raw email may be HMACed transiently as `derived`, but no workspace class may be inferred. Provide manual owner profile management only; do not add automatic selection/ranking.

- [ ] **Step 4: Run GREEN and the exact current-runtime blocker fixture**

```bash
node --import tsx --test tests/secure-control-store.test.ts tests/subscription-profiles.test.ts tests/codex-profile-runtime.test.ts tests/profile-attestation.test.ts tests/codex-profile-isolation.test.ts tests/owner-profile-route-authority.test.ts
npm run check
```

Expected: PASS. The 0.142.5-shaped `{ email, planType }` account fixture must deterministically return `{ kind: "blocked", reason: "missing_workspace_class" }` for every pair, with zero target dispatch.

- [ ] **Step 5: Commit Child Plan 2**

```bash
git add src/secure-control-store.ts src/subscription-profiles.ts src/codex-profile-runtime.ts src/profile-attestation.ts src/owner-profile-route-authority.ts src/codex-home.ts src/codex-app-server.ts src/backend-codex.ts src/setup.ts src/commands.ts tests/secure-control-store.test.ts tests/subscription-profiles.test.ts tests/codex-profile-runtime.test.ts tests/profile-attestation.test.ts tests/codex-profile-isolation.test.ts tests/owner-profile-route-authority.test.ts
git commit -m "feat: isolate owner Codex subscription profiles"
```

**Exit Gate / Outcome:** Profile plumbing may be used for explicit ordinary owner route choice only. Child Plan 3 is unblocked after isolation evidence passes. Handoff remains BLOCKED on Codex 0.142.5 because `workspace_class`/workspace binding is absent.

---

### Child Plan 3: Signed Deny-by-Default Policy and Typed Exhaustion Classifier

**Dependencies:** Child Plan 2 PASS. Provider contract fixtures must use synthetic typed metadata only.

**Files:**
- Create: `src/provider-handoff-policy.ts`
- Create: `src/subscription-limit-classifier.ts`
- Create: `tests/provider-handoff-policy.test.ts`
- Create: `tests/subscription-limit-classifier.test.ts`

**Interfaces:**
- Consumes: pinned release trust root, monotonic local revocation epoch, exact provider/profile/runtime/region/terms/legal facts, typed app-server terminal failure, and fresh rate-limit observation.
- Produces: `ProviderHandoffPolicyV1`, `ProviderHandoffPolicyVerifier`, `ProviderHandoffEvaluationV1`, `SubscriptionLimitEvidenceV1`, and `classifySubscriptionLimit()`.

```ts
export interface ProviderHandoffPolicyV1 {
  version: 1;
  policyId: string;
  policyRevision: number;
  decision: "allow" | "deny";
  providerId: "codex";
  sourcePlanClass: string;
  sourceWorkspaceClass: string;
  targetPlanClass: string;
  targetWorkspaceClass: string;
  region: string;
  codexVersionRange: string;
  termsDocumentId: string;
  termsRevision: string;
  termsDigest: string;
  legalReviewRevision: string;
  effectiveAt: number;
  expiresAt: number;
  revocationEpoch: number;
  signerKeyId: string;
  signature: string;
}

export interface ProviderHandoffEvaluationV1 {
  version: 1;
  providerHandoffPolicyDigest: string;
  sourceAccountBindingScheme: string;
  sourceAccountBindingDigest: string;
  sourcePlanClass: string;
  sourceWorkspaceClass: string;
  targetAccountBindingScheme: string;
  targetAccountBindingDigest: string;
  targetPlanClass: string;
  targetWorkspaceClass: string;
  region: string;
  codexVersion: string;
  termsRevision: string;
  legalReviewRevision: string;
  policyExpiresAt: number;
  policyRevocationEpoch: number;
  evaluationDigest: string;
}

export interface SubscriptionLimitEvidenceV1 {
  version: 1;
  phase: "preflight" | "terminal";
  typedTurnError: "UsageLimitExceeded" | "other" | null;
  acceptedTerminalAssistantAnswer: boolean;
  accountBindingScheme: string;
  accountBindingDigest: string;
  profileGeneration: number;
  planClass: string | null;
  workspaceClass: string | null;
  providerBucketId: string | null;
  rateLimitReachedType: string | null;
  runtimeVersion: string;
  observedAt: number;
  corroboratedAt: number | null;
}

export type SubscriptionLimitClass =
  | "available"
  | "approaching_limit"
  | "preflight_subscription_limit_reached"
  | "confirmed_subscription_exhausted"
  | "provider_rate_limited_unknown"
  | "auth_required"
  | "network_unavailable"
  | "runtime_error"
  | "local_budget_blocked"
  | "indeterminate";

export function classifySubscriptionLimit(
  evidence: SubscriptionLimitEvidenceV1,
): SubscriptionLimitClass;
```

- [ ] **Step 1: Write failing policy/classifier matrices**

Policy tests cover absent, malformed, future, deny, bad signature, expired/not-yet-effective, revoked, clock rollback, wrong region/version/terms/legal revision/plan/workspace, downgrade, and exact allow tuple. Classifier tests cover every class; only terminal typed `UsageLimitExceeded` plus fresh matching `rateLimitReachedType` for exact source binding/profile generation/plan/workspace/bucket/runtime/version and no accepted terminal answer may yield confirmed exhaustion. Reached preflight must produce its distinct class and zero target calls.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/provider-handoff-policy.test.ts tests/subscription-limit-classifier.test.ts
```

Expected: FAIL because policy verification and classifier do not exist.

- [ ] **Step 3: Implement authenticated evaluation and exact evidence matching**

Ship only the pinned verifier/trust root and a deny fixture; do not bundle an allow artifact. Materialize a target-bound evaluation digest over provider, both account schemes/digests, exact plan/workspace classes, region, Codex version, terms/legal revisions, expiry, and revocation epoch. Treat every missing/unknown field as deny. Persist normalized evidence category/digests only, never raw payload/error text.

- [ ] **Step 4: Run GREEN and current blocker assertions**

```bash
node --import tsx --test tests/provider-handoff-policy.test.ts tests/subscription-limit-classifier.test.ts
npm run check
```

Expected: PASS. Missing `workspaceClass` prevents evaluation before any allow decision, even if the policy signature and exhaustion evidence are otherwise valid.

- [ ] **Step 5: Commit Child Plan 3**

```bash
git add src/provider-handoff-policy.ts src/subscription-limit-classifier.ts tests/provider-handoff-policy.test.ts tests/subscription-limit-classifier.test.ts
git commit -m "feat: gate handoff with signed policy and typed limits"
```

**Exit Gate / Outcome:** UNBLOCK Child Plan 4 for storage/replay mechanics. Runtime dispatch remains disabled without a current exact allow artifact and complete plan/workspace facts.

---

### Child Plan 4: Zero-Redispatch Effect Ledger and Encrypted Continuation Checkpoint

**Dependencies:** Child Plans 1-3 PASS; managed-operation journal, writer drain, `ChangeJournal`, run event cursor, and canonical task context are durable.

**Files:**
- Create: `src/effect-ledger.ts`
- Create: `src/handoff-crypto.ts`
- Create: `src/task-continuation.ts`
- Create: `src/handoff-operation-journal.ts`
- Create: `tests/effect-ledger.test.ts`
- Create: `tests/handoff-crypto.test.ts`
- Create: `tests/task-continuation.test.ts`
- Create: `tests/handoff-operation-journal.test.ts`
- Modify: `src/core.ts`
- Modify: `src/events.ts`
- Modify: `src/storage.ts`
- Modify: `src/private-store.ts`
- Modify: `src/workspace.ts`
- Modify: `src/runlog.ts`

**Interfaces:**
- Consumes: terminal source operation/evidence, drained core, immutable authority/provenance, canonical task/workspace/run artifacts, policy digest, profile facts, and Child Plan 2 `SecureControlStore`; `handoff-crypto.ts` domain-separates checkpoint/grant keys and does not introduce a second master-key store.
- Produces: `EffectReplayRecordV1`, `EffectLedger`, `TaskContinuationCheckpointV1`, `TaskContinuationStore`, `HandoffOperationJournalV1`, and target-unbound/target-bound generation CAS.

```ts
export interface EffectReplayRecordV1 {
  version: 1;
  effectId: string;
  logicalCallId: string;
  sourceAttemptId: string;
  canonicalActionDigest: string;
  reusableIdempotencyIdentity: string;
  effectScopeAndTargetBinding: string;
  terminalResultReference: string;
  resultDigest: string;
  dispatchCount: 1;
  approvalDecisionDigest: string;
  decisionSource: "explicit" | "remembered" | "yolo";
  recordGeneration: number;
}

export interface TargetCheckpointBindingV1 {
  targetProfileId: string;
  targetProfileGeneration: number;
  targetAccountBindingScheme: string;
  targetAccountBindingDigest: string;
  targetAccountBindingStrength: "verified_opaque" | "derived";
  targetAccountBindingObservationId: string;
  targetAccountBindingObservedAt: number;
  targetPlanClass: string;
  targetWorkspaceClass: string;
  targetOwnerAttestationId: string;
  targetOwnerAttestationDigest: string;
  targetOwnerAttestationExpiresAt: number;
  targetCredentialNamespaceDigest: string;
  providerHandoffEvaluationDigest: string;
}

export interface TaskContinuationCheckpointV1 {
  schemaVersion: 1;
  checkpointId: string;
  checkpointGeneration: number;
  logicalTaskId: string;
  chatId: string;
  sourceRunId: string;
  logicalCallId: string;
  failedAttemptId: string;
  originatingPrincipalId: string;
  originatingPrincipalClass: "owner" | "owner_device";
  principalEpoch: number;
  capabilityEpoch: number;
  inputProvenanceRoot: string;
  inputProvenanceRecordRefs: readonly string[];
  ownerAdoptionDigests: readonly string[];
  canonicalOwnerId: string;
  executorDeviceId: string;
  workspaceRootIdentity: string;
  workspaceBaselineFingerprint: string;
  trackedFileHashes: Readonly<Record<string, string>>;
  currentDiffDigest: string;
  changeJournalCursor: string;
  runEventCursor: string;
  conversationCursor: string;
  originalUserRequestReference: string;
  attachmentReferencesAndDigests: readonly string[];
  canonicalOrcodeContext: string;
  completedModelItemReferences: readonly string[];
  completedToolResults: readonly string[];
  resolvedApprovalRecords: readonly string[];
  taskTreeAndPlanState: string;
  policyAndBudgetState: string;
  usageAndCostLedger: string;
  externalEffectCount: number;
  effectLedgerDigest: string;
  effectRecordRefs: readonly string[];
  effectReplayEligibility: "none" | "stored-result-zero-redispatch" | "blocked";
  sourceProfileId: string;
  sourceProfileGeneration: number;
  sourceRouteAndModel: string;
  sourceBillingRealm: "chatgpt-subscription-provider-managed-overage";
  sourceAccountBindingScheme: string;
  sourceAccountBindingDigest: string;
  sourceAccountBindingStrength: "verified_opaque" | "derived";
  sourceAccountBindingObservationId: string;
  sourceAccountBindingObservedAt: number;
  sourcePlanClass: string;
  sourceWorkspaceClass: string;
  sourceOwnerAttestationId: string;
  sourceOwnerAttestationDigest: string;
  sourceOwnerAttestationExpiresAt: number;
  failurePhase: "terminal";
  normalizedFailureClass: "confirmed_subscription_exhausted";
  typedEvidenceDigest: string;
  inputDigest: string;
  providerAcceptanceState: "terminal";
  retryEligibility: "eligible" | "blocked";
  providerHandoffPolicyDigest: string;
  proposedTargetProfileId: string | null;
  targetBinding: TargetCheckpointBindingV1 | null;
  createdAt: number;
  expiresAt: number | null;
}
```

`TargetCheckpointBindingV1` is all-or-nothing; a promptable generation cannot contain null target fields.

- [ ] **Step 1: Write failing effect/checkpoint/crypto/journal tests**

Cover every effect class, default blocking, missing/stale/ambiguous/provider-scoped idempotency, stored-result authentication, zero redispatch counters, YOLO dispatch count, checkpoint schema round-trip/future refusal, secret/raw-provider/reasoning exclusion, owner/device encryption binding, tamper/truncation/key loss/wrong root, atomic write/rename/fsync fault injection, source states prepared/sent/acknowledged/streaming/terminal/indeterminate, target-binding generation CAS, and crashes before/after checkpoint publication and retry binding.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/effect-ledger.test.ts tests/handoff-crypto.test.ts tests/task-continuation.test.ts tests/handoff-operation-journal.test.ts
```

Expected: FAIL because the ledger/checkpoint/crypto modules do not exist.

- [ ] **Step 3: Implement drain, inventory, encryption, and durable publication**

Stop scheduling, obtain the exact terminal exhaustion evidence, drain tool/process/stream/approval/writer owners, reconcile run log and `ChangeJournal`, freeze authority/provenance, inventory effects, snapshot canonical state, authenticate-encrypt with the device key, write/fsync/rename, read back and verify, and only then publish a target-unbound checkpoint. Binding a target creates a new complete generation. Any failure remains `checkpoint_failed`, `blocked_external_effect`, or `blocked_indeterminate` with zero provider send.

- [ ] **Step 4: Run GREEN and full safety regressions**

```bash
node --import tsx --test tests/effect-ledger.test.ts tests/handoff-crypto.test.ts tests/task-continuation.test.ts tests/handoff-operation-journal.test.ts
npm run check
```

Expected: PASS; replay-safe target consumption increments only stored-result reads, never effect dispatch counters.

- [ ] **Step 5: Commit Child Plan 4**

```bash
git add src/effect-ledger.ts src/handoff-crypto.ts src/task-continuation.ts src/handoff-operation-journal.ts src/core.ts src/events.ts src/storage.ts src/private-store.ts src/workspace.ts src/runlog.ts tests/effect-ledger.test.ts tests/handoff-crypto.test.ts tests/task-continuation.test.ts tests/handoff-operation-journal.test.ts
git commit -m "feat: checkpoint handoff without replaying effects"
```

**Exit Gate / Outcome:** UNBLOCK Child Plan 5 only when checkpoint publication and stored-result replay are durable across all crash points. No prompt exists yet; handoff remains unavailable.

---

### Child Plan 5: Handoff Coordinator, One-Use Grant, and Owner UX

**Dependencies:** Child Plans 1-4 PASS. Exact policy/profile/effect/checkpoint revalidation functions are pure and callable under one dispatch CAS.

**Files:**
- Create: `src/handoff-coordinator.ts`
- Create: `src/handoff-grant.ts`
- Create: `src/handoff-ui.ts`
- Create: `tests/handoff-coordinator.test.ts`
- Create: `tests/handoff-grant.test.ts`
- Create: `tests/handoff-ui.test.ts`
- Create: `tests/handoff-collaborator-abuse.test.ts`
- Create: `tests/handoff-pty.test.ts`
- Modify: `src/core.ts`
- Modify: `src/events.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands.ts`
- Modify: `src/command-catalog.ts`
- Modify: `src/tui.ts`
- Modify: `src/setup-ui.ts`
- Modify: `src/redaction.ts`

**Interfaces:**
- Consumes: target-bound checkpoint, one exact eligible target, current authenticated policy/evaluation, current owner/device principal, fresh profile/rate-limit/account/plan/workspace/attestation facts, and durable operation/effect journals.
- Produces: `HandoffCoordinator`, `HandoffConfirmationV1`, `HandoffIntentV1`, `HandoffEventV1`, and owner-only TUI/plain/JSON/remote rendering.

```ts
export type HandoffState =
  | "terminal_usage_limit_failure_observed"
  | "corroborating_terminal_exhaustion"
  | "checkpointing"
  | "binding_target_and_policy"
  | "paused_awaiting_owner"
  | "paused_waiting_reset"
  | "authorizing_target"
  | "retry_bound"
  | "effect_time_dispatch_cas"
  | "retry_sent"
  | "running"
  | "completed"
  | "cancelled"
  | "checkpoint_failed"
  | "blocked_unconfirmed_limit"
  | "blocked_collaborator_provenance"
  | "blocked_external_effect"
  | "blocked_account_binding"
  | "blocked_plan_or_workspace"
  | "blocked_owner_attestation"
  | "blocked_policy_invalid_inspect_only"
  | "blocked_indeterminate"
  | "paused_stale_confirmation"
  | "paused_target_unavailable";

export type HandoffIntentV1 =
  | { version: 1; type: "select-target"; checkpointId: string; checkpointGeneration: number; targetProfileId: string }
  | { version: 1; type: "confirm"; confirmationId: string }
  | { version: 1; type: "wait"; checkpointId: string; checkpointGeneration: number }
  | { version: 1; type: "cancel"; checkpointId: string; checkpointGeneration: number; disposition: "retain" | "discard" | "existing-safe-undo" };

export interface HandoffEventV1 {
  version: 1;
  sequence: number;
  logicalTaskId: string;
  logicalCallId: string;
  checkpointId: string;
  checkpointGeneration: number;
  state: HandoffState;
  normalizedReasonCode: string;
  targetProfileId: string | null;
  ownerActionRequired: boolean;
  timestamp: number;
}

export interface HandoffConfirmationV1 {
  version: 1;
  confirmationId: string;
  checkpointId: string;
  checkpointGeneration: number;
  logicalTaskId: string;
  logicalCallId: string;
  inputDigest: string;
  originatingPrincipalId: string;
  originatingPrincipalClass: "owner" | "owner_device";
  principalEpoch: number;
  capabilityEpoch: number;
  inputProvenanceRoot: string;
  ownerAdoptionDigests: readonly string[];
  sourceProfileId: string;
  sourceProfileGeneration: number;
  sourceAccountBindingScheme: string;
  sourceAccountBindingDigest: string;
  sourceAccountBindingStrength: "verified_opaque" | "derived";
  sourceAccountBindingObservationId: string;
  sourceAccountBindingObservedAt: number;
  sourcePlanClass: string;
  sourceWorkspaceClass: string;
  sourceAttestationId: string;
  sourceAttestationDigest: string;
  sourceAttestationExpiresAt: number;
  targetProfileId: string;
  targetProfileGeneration: number;
  targetAccountBindingScheme: string;
  targetAccountBindingDigest: string;
  targetAccountBindingStrength: "verified_opaque" | "derived";
  targetAccountBindingObservationId: string;
  targetAccountBindingObservedAt: number;
  targetPlanClass: string;
  targetWorkspaceClass: string;
  targetAttestationId: string;
  targetAttestationDigest: string;
  targetAttestationExpiresAt: number;
  targetCredentialNamespaceDigest: string;
  targetRateLimitObservationId: string;
  targetRateLimitClass: "available";
  targetRateLimitObservedAt: number;
  route: string;
  canonicalModel: string;
  billingRealm: "chatgpt-subscription-provider-managed-overage";
  effectLedgerDigest: string;
  effectReplayEligibility: "none" | "stored-result-zero-redispatch";
  providerHandoffPolicyDigest: string;
  providerHandoffEvaluationDigest: string;
  region: string;
  codexVersion: string;
  termsRevision: string;
  legalReviewRevision: string;
  policyExpiresAt: number;
  policyRevocationEpoch: number;
  ownerId: string;
  executorDeviceId: string;
  confirmingDeviceId: string;
  issuedAt: number;
  expiresAt: number;
}
```

`HandoffConfirmationV1` is one-use and atomically consumed immediately before first target bytes.

- [ ] **Step 1: Write failing coordinator/grant/UX/abuse tests**

Cover the complete state graph, double-click/two-device races, stale generation/login/plan/workspace/attestation/policy/terms/region/model/workspace/provenance/effect changes, crash boundaries, target exhaustion/revocation, and indeterminate send. Assert exact German copy only when exactly one target is eligible:

```text
Abo 1 ist bestätigt ausgeschöpft.
Sicherer Task-Checkpoint gespeichert.

[Mit Abo 2 fortfahren?]  [Warten]  [Abbrechen]
```

Several ready targets require separate owner selection. If no ready target exists, setup is a separate owner action; after enrollment the coordinator revalidates every source/target/policy fact and only then may ask. Reached preflight, profile-only, same account, missing workspace class, invalid policy, collaborator provenance, external effect, API billing, and unavailable target render no one-click action. Build an abuse matrix for local/remote collaborator, imported task, malicious content, replayed link, guessed profile ID, stolen checkpoint, changed principal, and confused-deputy call; every path must fail before profile/keyring/runtime/network/quota/audit access.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/handoff-coordinator.test.ts tests/handoff-grant.test.ts tests/handoff-ui.test.ts tests/handoff-collaborator-abuse.test.ts tests/handoff-pty.test.ts
```

Expected: FAIL because no coordinator, grant, or handoff UI exists.

- [ ] **Step 3: Implement the target-bound pause and effect-time dispatch fence**

Expose handoff intents only to authenticated owner/owner-device surfaces. Mint a short-lived grant after deliberate activation, then under one CAS revalidate and consume the grant, checkpoint generation, source/target facts, policy/evaluation, current clock/revocation, principal/capability/provenance, effect ledger, workspace, route/model, and operation journal. The transport cannot open or write before this fence passes. Start a new `attempt_id` for the same `logical_call_id`; supply canonical Orcode context and stored results, not provider-owned hidden state. Wait/decline/cancel never invokes a provider.

- [ ] **Step 4: Run GREEN, PTY, and full regressions**

```bash
node --import tsx --test tests/handoff-coordinator.test.ts tests/handoff-grant.test.ts tests/handoff-ui.test.ts tests/handoff-collaborator-abuse.test.ts tests/handoff-pty.test.ts
npm run test:pty
npm run check
```

Expected: PASS. With the current 0.142.5-shaped account fixture, every surface remains unavailable and performs zero target calls because workspace class is missing.

- [ ] **Step 5: Commit Child Plan 5**

```bash
git add src/handoff-coordinator.ts src/handoff-grant.ts src/handoff-ui.ts src/core.ts src/events.ts src/cli.ts src/commands.ts src/command-catalog.ts src/tui.ts src/setup-ui.ts src/redaction.ts tests/handoff-coordinator.test.ts tests/handoff-grant.test.ts tests/handoff-ui.test.ts tests/handoff-collaborator-abuse.test.ts tests/handoff-pty.test.ts
git commit -m "feat: add explicit owner handoff coordinator"
```

**Exit Gate / Outcome:** UNBLOCK Child Plan 6 verification. The code path exists but remains Preview-off and dispatch-denied without the final release gate and current exact allow policy.

---

### Child Plan 6: Provider Contract, Isolation, Compliance, and Release Gate

**Dependencies:** Child Plans 1-5 PASS and no unresolved P0/P1 review findings.

**Files:**
- Create: `scripts/check-owner-handoff-contract.mjs`
- Create: `scripts/check-owner-handoff-isolation.mjs`
- Create: `scripts/check-owner-handoff-release.mjs`
- Create: `tests/owner-handoff-release.test.ts`
- Create: `docs/release/owner-handoff-policy-format.md`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: current official auth/config/pricing/app-server/API/terms documents, documented product/legal decision, signed policy artifact supplied by the release process, exact Codex range, exact OS/keyring tuple, test-owned owner accounts with explicit consent, and sanitized smoke evidence.
- Produces: `OwnerHandoffReleaseRecordV1` and a binary release decision `enabled` or `blocked`; it never fabricates an allow policy.

```ts
export interface OwnerHandoffReleaseRecordV1 {
  version: 1;
  reviewedAt: string;
  documentUrls: readonly string[];
  documentDigests: readonly string[];
  legalReviewRevision: string;
  providerDecision: "allow" | "deny" | "ambiguous";
  policyDigest: string | null;
  platform: NodeJS.Platform;
  keyringMechanism: string;
  codexVersion: string;
  region: string;
  sourcePlanClass: string;
  sourceWorkspaceClass: string;
  targetPlanClass: string;
  targetWorkspaceClass: string;
  contractGate: "pass" | "fail";
  isolationGate: "pass" | "fail";
  repositoryGate: "pass" | "fail";
  decision: "enabled" | "blocked";
  normalizedReasons: readonly string[];
}
```

- [ ] **Step 1: Write failing release-gate tests**

Assert the gate blocks absent/ambiguous legal review, no policy, deny/expired/revoked policy, missing workspace class, unsupported protocol/version/region/plan/workspace, incomplete keyring isolation, captured credential material, only simulated exhaustion, failed package/build/privacy/regression checks, or missing normal-exit/forced-crash sentinel evidence. Assert `auth.json` copy and `chatgptAuthTokens` are recognized then rejected by policy tests. Public copy must reject “unlimited,” “combined quota,” “pool,” “rotation,” “load balancing,” and provider endorsement.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/owner-handoff-release.test.ts
```

Expected: FAIL because release scripts/record do not exist.

- [ ] **Step 3: Implement exact binary gates and sanitized evidence output**

`check-owner-handoff-contract.mjs` records current document URLs/digests/review date and black-box protocol support. `check-owner-handoff-isolation.mjs` proves A/B keyring/home/account/rate-limit/logout separation without token inspection. `check-owner-handoff-release.mjs` verifies the signed policy/evaluation tuple, live evidence, repository checks, and prohibited-copy scan, then emits only normalized non-secret facts. Any unavailable fact produces `decision: "blocked"`; there is no force flag.

- [ ] **Step 4: Run repository and live release commands**

```bash
node --import tsx --test tests/owner-handoff-release.test.ts
npm run check
npm run build
npm run check:package
orcode_release_version="$(node -p 'require("./package.json").version')"
npm run check:release -- --tag "v${orcode_release_version}"
npm run test:pty
node scripts/check-owner-handoff-contract.mjs
node scripts/check-owner-handoff-isolation.mjs
node scripts/check-owner-handoff-release.mjs
```

Run package and release-metadata checks serially, and copy the resolved exact tag into the sanitized release record. The metadata check creates no tag and publishes nothing. Expected on the currently observed Codex 0.142.5 tuple: deterministic/unit/package checks may PASS, but the final release record is `decision: "blocked"` with normalized reason `missing_workspace_class`; handoff stays absent/unavailable and zero target request bytes are sent.

- [ ] **Step 5: Commit the deny-by-default release machinery**

```bash
git add scripts/check-owner-handoff-contract.mjs scripts/check-owner-handoff-isolation.mjs scripts/check-owner-handoff-release.mjs tests/owner-handoff-release.test.ts docs/release/owner-handoff-policy-format.md package.json README.md
git commit -m "chore: gate owner subscription handoff release"
```

**Exit Gate / Outcome:**

- **BLOCKED** if any exact provider/legal/policy/account/workspace/isolation/runtime/platform/repository fact is missing or negative. The feature remains absent or explicitly unavailable; checkpoints are inspect/delete-only where required.
- **ENABLED for one exact tuple only** when every child plan passes, current official review expressly permits the behavior, a signed nonexpired allow policy matches the exact tuple, source and target expose fresh distinct comparable bindings plus exact approved plan/workspace classes, isolation/live smokes pass, and the release record says `enabled`.
- Enabling one tuple does not authorize automatic switching, other plans/regions/versions/platforms, collaborator use, or API fallback. Each new tuple requires a new signed policy and release record.

## Program Completion Gate

- All six child plans are executed sequentially; no later child may weaken or bypass an earlier exit gate.
- Child-plan commits are independently reviewable and retain their named RED/GREEN evidence.
- Current Codex 0.142.5 evidence is a deliberate blocked outcome: email plus `planType` is insufficient because `workspace_class`/workspace ID is absent.
- The correct current product behavior is single-profile manual Codex Preview only, no handoff prompt, no automatic switching, and collaborator bring-your-own-provider enforcement.
