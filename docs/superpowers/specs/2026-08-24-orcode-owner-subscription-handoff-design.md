# Orcode Owner Subscription Handoff Design

Date: 2026-08-24  
Status: Approved product direction; design specification only  
Depends on: `2026-08-22-orcode-0.7-design.md`,
`2026-08-23-orcode-startup-provider-setup-design.md`, and
`2026-08-23-orcode-remote-relay-design.md`

## 1. Decision summary

Orcode may let its single owner enroll more than one of that owner's separately
authenticated personal ChatGPT Pro accounts with Codex as isolated **owner
subscription profiles**. Other eligible personal ChatGPT plan classes require
their own release-time eligibility decision; they are not silently treated as
Pro. When the active profile is conclusively out of included Codex usage,
Orcode may save a durable task continuation checkpoint and offer one explicit
action:

```text
Mit Abo 2 fortfahren?
```

Only the owner can confirm that action. Confirmation changes the provider
profile for one failed model call, then resumes the same logical Orcode task.
Already completed model calls, tools, approvals, and file effects are not run
again. Provider credentials, opaque provider session state, and hidden model
reasoning are never copied between profiles.

A reached preflight is not a failed call and cannot enter this flow. Handoff
requires a typed terminal usage-limit failure, fresh matching rate-limit
confirmation, two freshly revalidated distinct eligible account bindings,
owner-device attestations, owner-authorized input provenance, replay-safe effect
history, and a still-current compliance policy at the instant before target
request bytes are sent.

This is a manual continuity feature, not subscription pooling as a service and
not automatic account rotation. Fully automatic selection, failover, or
round-robin use of personal subscriptions remains disabled unless OpenAI later
publishes an official contract that expressly supports it and a new design is
approved.

Every subscription profile is owner-only. Collaborators may receive tasks,
patches, source files, and sanitized continuation bundles, but must attach
their own provider account or API route. They cannot enumerate, inspect,
select, spend from, or indirectly proxy through the owner's subscription
profiles.

## 2. Authority and documentation boundary

This design uses only public OpenAI documentation and the locally installed
Codex CLI as provider-contract evidence. Repository documents define Orcode's
own stricter safety policy; they do not enlarge OpenAI's contract.

### 2.1 What the public OpenAI documentation supports

The reviewed public documentation supports these individual seams:

- [Codex authentication](https://learn.chatgpt.com/docs/auth) distinguishes
  ChatGPT subscription login from API-key authentication, documents browser
  and device-code login, documents `cli_auth_credentials_store` for selecting
  file or operating-system credential-store caching, and describes a fallback
  that copies one `auth.json` cache to a headless Codex environment.
- [Codex basic configuration](https://learn.chatgpt.com/docs/config-file/config-basic)
  documents configuration layers, their precedence, and named configuration
  profiles selected with `--profile`. It does not describe those profiles as
  authentication identities or account pools.
- [Codex pricing](https://learn.chatgpt.com/docs/pricing) documents that Codex
  is included in eligible ChatGPT plans, that limits are shared and
  task-dependent, and that API-key use is separately usage-based.
- [The Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
  documents `account/login/start`, `account/read`,
  `account/rateLimits/read`, rate-limit notifications, typed turn errors,
  thread start/resume, turn lifecycle events, and the experimental
  `chatgptAuthTokens` mode for a host application that already owns the user's
  ChatGPT authentication lifecycle.
- [The OpenAI API overview](https://developers.openai.com/api/reference/overview)
  documents API keys and optional Organization and Project routing headers.
  API usage is attributed to that API organization/project route, not to a
  ChatGPT subscription profile.
- [OpenAI's Europe Terms of Use](https://openai.com/policies/terms-of-use/)
  prohibit sharing account credentials or making an account available to
  somebody else and prohibit circumventing rate limits, restrictions, or
  protective measures. Those rules make collaborator isolation mandatory and
  make manual multi-profile handoff a release-time compliance question, not an
  assumed entitlement.

These seams are sufficient to design owner-driven enrollment, typed usage
classification, and an explicit handoff prompt around the official Codex
runtime. They are not evidence of a provider-supported pool.

### 2.2 What the public documentation does not promise

Two documented authentication seams must not be mistaken for pooling support:

- Codex authentication describes copying a single `auth.json` cache from a
  browser-capable machine to a trusted headless Codex environment, while
  warning that the file contains access tokens and must be treated like a
  password.
- The app-server protocol describes experimental `chatgptAuthTokens` for a
  host application that already owns the user's ChatGPT authentication
  lifecycle, supplies the access token and account identifier, and services
  token-refresh requests.

Those are documented credential-portability and host-owned-auth seams for
their stated contexts. Neither is a contract for multi-account subscription
pooling, subscription handoff, or account rotation. As of 2026-08-24, the
reviewed public OpenAI documentation exposes no contract for any of the
following:

- aggregating or pooling multiple personal ChatGPT subscriptions;
- automatically rotating among personal subscription accounts;
- transferring a live provider turn, thread, token, cache, or entitlement
  between accounts;
- using credential portability or externally managed tokens to construct a
  multi-account subscription pool, handoff, or rotation mechanism;
- treating a configuration profile as an authentication pool;
- lending one person's subscription access to collaborators or remote users.

Orcode deliberately excludes both documented credential seams from this
feature as a stricter security and product choice. Owner subscription handoff
never reads, copies, imports, or exports `auth.json`; never supplies or
refreshes ChatGPT tokens through `chatgptAuthTokens`; and never converts either
seam into an enrollment shortcut. Every profile instead completes its own
Codex-managed browser or device-code login in its isolated runtime. This is an
Orcode restriction, not a claim that the two seams are absent from the
official documentation.

Absence of a documented contract is not permission. Orcode therefore names
this feature **owner subscription handoff**, keeps every switch explicit, and
does not claim that OpenAI endorses subscription pooling. The technical design
does not decide whether switching after exhaustion would constitute prohibited
rate-limit circumvention in a particular plan or jurisdiction. Until a current
official clarification or documented product/legal review concludes that the
exact manual owner-only behavior is permitted, the feature remains disabled.

### 2.3 API key, Organization, and Project are a separate route

An OpenAI API key is not “Abo 3.” It is a separate, usage-based provider route
with its own billing, credentials, Organization, Project, limits, policy, and
audit identity. Orcode must never silently substitute an API key when a
ChatGPT subscription is exhausted.

The owner may separately configure and explicitly select an API-key route if
the existing provider design supports it. Any later prompt to continue through
that route must name the billing change and obtain separate consent. It is not
part of the one-click subscription-to-subscription path specified here.

### 2.4 Local Codex CLI capability snapshot

The local executable inspected for this design reports `codex-cli 0.142.5`.
Its help exposes:

- `codex login --device-auth` for the documented device-code login;
- `--profile <CONFIG_PROFILE_V2>` to layer a named configuration file from
  `$CODEX_HOME` over the base configuration.

The inspected command surface exposes no native subscription-pool,
multi-account rotation, or account-handoff command. `--profile` is a
configuration-layer selector, not proof of independent authentication or a
provider-supported account pool. Orcode may use distinct configuration homes
as an isolation primitive only after proving their credential-store namespaces
are independent on the exact supported CLI and operating system.

This capability snapshot is version-specific. Release checks must repeat it
for every supported Codex version rather than treating 0.142.5 behavior as a
permanent contract.

## 3. Scope

### 3.1 In scope

- enrollment of two or more personal ChatGPT/Codex subscription profiles that
  belong to the same Orcode owner;
- official Codex browser or device-code authentication without credential
  access by Orcode;
- isolated runtime homes and operating-system credential-store entries;
- fresh distinct account and plan/workspace binding plus owner-device ownership
  attestation for both profiles;
- profile readiness and typed usage-limit classification;
- immutable principal/capability provenance for every user and steering input;
- failed-turn effect inventory with stored-result, zero-redispatch semantics;
- an authenticated expiring and revocable effect-time compliance policy;
- a durable, encrypted task continuation checkpoint;
- an explicit one-click handoff to one already enrolled eligible profile;
- retry of only the provider call that failed from confirmed included-usage
  exhaustion;
- same-logical-task continuation across an in-process pause or an Orcode
  restart;
- owner-device authorization, audit minimization, cancellation, recovery, and
  deletion semantics;
- strict collaborator bring-your-own-provider enforcement;
- Preview release gates and fail-closed unsupported states.

### 3.2 Normative language

“Must,” “must not,” and “only” are release requirements. “May” describes an
allowed behavior, not a required fallback. A missing provider fact is
`unknown`, never an inferred success.

## 4. Terms and identities

### 4.1 Principal types

Orcode distinguishes these principals before any provider operation:

| Principal | Meaning | Owner subscription capability |
| --- | --- | --- |
| `owner` | The one local Orcode owner | Enroll, inspect sanitized status, select, confirm, revoke |
| `owner_device` | An explicitly enrolled personal device acting for that same owner | May request or confirm through the executor, subject to device policy |
| `collaborator` | Another person, agent, tenant, shared client, or service | None; BYO provider only |
| `executor` | The owner-controlled machine/process that owns the provider runtime | Performs calls; never exports credentials |

A collaborator cannot become an `owner_device` merely by possessing a task
link, repository checkout, relay session, chat identifier, or local network
access. Changing principal class requires a separate owner-device enrollment
ceremony with revocation support.

### 4.2 Stable Orcode identifiers

Orcode creates and stores only its own opaque identifiers:

- `owner_id`: a random local principal identifier;
- `device_id`: a random identifier bound to a device key;
- `subscription_profile_id`: a random identifier for one isolated profile;
- `logical_task_id`: stable across the pause and handoff;
- `logical_call_id`: stable for the provider call being retried;
- `attempt_id`: new for each authorized provider attempt;
- `checkpoint_id` and monotonic `checkpoint_generation`;
- `confirmation_id`: a one-use authorization to resume;
- `principal_epoch`: a monotonic generation for the authenticated principal;
- `capability_epoch`: a monotonic generation for that principal's effective
  capabilities.

None is an OpenAI account identifier, token, entitlement, or credential.

### 4.3 Owner-device binding

The local owner binding is the conjunction of:

1. the canonical operating-system account identity, such as UID or SID;
2. the Orcode `owner_id`;
3. a non-exportable or operating-system-protected device key;
4. the canonical private Orcode home and executor identity;
5. an enrolled `device_id` when confirmation originates on another personal
   device.

Provider profile operations require all applicable elements to match. File
ownership alone, a bearer chat cookie, or knowledge of a profile label is not
sufficient.

For a personal remote device, the owner-device channel may authorize the
executor to perform a handoff, but it never receives a provider token, Codex
home, keyring item, raw quota payload, or provider session. The executor
remains the sole provider-credential boundary.

### 4.4 Input provenance and owner adoption

Every user message, quick reply, attachment, remote command, and steering input
that can influence a provider call is durably represented by an
`InputProvenanceV1` record before it enters canonical task context:

```text
input_event_id
logical_task_id + chat_id
input_kind                     # user | steer | attachment | remote_command
originating_principal_id
originating_principal_class    # owner | owner_device | collaborator
principal_epoch
capability_epoch
authenticated_channel_and_device_binding
content_digest
attachment_digests
received_event_sequence
received_at
owner_adoption_digest?
```

The logical call stores its first `originating_principal` plus the ordered
provenance root over every input it consumes. Later steering never inherits the
first message's authority. A changed principal or capability epoch changes the
provenance root and invalidates any prepared checkpoint or grant.

The persisted call authority is explicit:

```text
logical_call_id
originating_principal_id + originating_principal_class
principal_epoch + capability_epoch
input_provenance_root + input_provenance_record_refs
owner_adoption_digests
provider_handoff_policy_digest?
authority_record_generation
```

Any collaborator-originated input in the logical call or its continuation
context makes that call ineligible for an owner subscription profile unless
the owner completed a separate `OwnerInputAdoptionV1` before the exhausted
source turn began. Adoption binds the exact input event IDs, content and
attachment digests, source principal and epochs, task/chat/workspace identity,
owner device, policy revision, and adoption time. It preserves the original
provenance for audit; it does not relabel the collaborator as owner.

Adoption is a content-specific owner decision, not a reusable capability. It
cannot be requested, rendered, or confirmed inside an exhaustion or handoff
prompt. Adoption after exhaustion cannot make the paused call eligible; the
owner must start a new ordinary owner-originated call. Any unadopted later
collaborator steer blocks handoff again.

### 4.5 Owner ownership attestation

Each handoff-eligible profile has a short-lived,
owner-device-bound `OwnerSubscriptionAttestationV1`:

```text
attestation_id
owner_id + attesting_device_id
subscription_profile_id
account_binding_scheme + account_binding_digest + strength
plan_class + workspace_class
profile_generation
principal_epoch + capability_epoch
attested_at + expires_at
attestation_revision
device_signature_or_mac
```

The owner explicitly attests that the separately authenticated account is
theirs to use and that its plan/workspace class is eligible under the current
policy. The device-bound record prevents a collaborator or stale device from
asserting that statement on the owner's behalf.

The official runtime observation can prove only login continuity to the same
observed account binding. Orcode cannot technically prove civil identity,
legal ownership, subscription entitlement, or provider permission. The
attestation therefore complements but never replaces the effect-time
compliance gate in section 7.1.

## 5. Subscription profile model

Each `OwnerSubscriptionProfileV1` contains only non-secret control metadata:

```text
subscription_profile_id
owner_id
executor_device_id
profile_generation
display_label                 # e.g. "Abo 1", owner editable
codex_home_binding_digest
credential_namespace_digest
codex_version_range
auth_mode                     # chatgpt only
account_binding_scheme?       # documented opaque scheme or derived scheme
account_binding_digest?       # keyed, never raw email/account text
account_binding_strength      # verified_opaque | derived | profile_only
account_binding_observation_id?
account_binding_observed_at?
plan_class?                   # sanitized documented enum, if returned
workspace_class?              # sanitized documented enum, if returned
owner_attestation_digest?
owner_attestation_expires_at?
state                         # see section 5.2
last_health_class
last_rate_limit_class
last_checked_at
created_at
updated_at
revoked_at?
```

The record contains no access token, refresh token, cookie, device code,
verification URL, API key, password, raw email address, provider response, or
provider error message.

### 5.1 Account binding strength and handoff eligibility

Orcode must not invent a stable provider account ID. If the supported official
runtime returns a documented opaque account or workspace identifier suitable
for binding, Orcode stores only a keyed digest and marks the binding
`verified_opaque`.

If the official runtime exposes only a human account identifier such as an
email address, Orcode may normalize it transiently inside the owner-only
executor, derive a keyed digest, immediately discard the source value, and mark
the binding `derived`. It must never log, export, display outside the enrollment
screen, or persist the raw value. The key is local to the owner device, so the
digest is not a cross-install tracking identifier.

If no stable documented identifier is available, the profile is
`profile_only`. That weaker state can still be used manually, but:

- Orcode must not claim that it cryptographically proved two profiles are
  distinct accounts;
- any detected login replacement requires explicit owner reconfirmation;
- no automatic action may depend on account uniqueness;
- duplicate-profile warnings are advisory, not identity proof.

`profile_only`, missing, unknown, stale, or non-comparable bindings are never
eligible for owner subscription handoff. Handoff requires a fresh,
nonoptional `verified_opaque` or `derived` binding for both source and target.
Both observations must use the same comparable binding scheme or an officially
documented canonical equivalence. Their digests must be different. A mismatch
of schemes cannot be treated as proof that two accounts are distinct.

Both profiles must also expose fresh, exact `plan_class` and `workspace_class`
values approved by the current `ProviderHandoffPolicy`. Unknown, missing,
changed, organization-managed, or otherwise nonapproved plan/workspace classes
block the feature. Orcode re-reads and revalidates the source and target
account, plan, workspace, profile generation, and owner attestation immediately
before target dispatch; enrollment-time facts alone are insufficient.

If the exact official runtime does not expose enough documented non-secret
account, plan, or workspace information to satisfy these checks, that runtime
tuple cannot ship handoff. Orcode does not compensate by scraping browser state,
reading tokens, or inferring identity from filesystem layout.

### 5.2 Profile state machine

```text
unenrolled
  -> enrolling
  -> ready
  -> usage_exhausted
  -> ready                 # only after a fresh official limit observation

ready|usage_exhausted
  -> reauth_required
  -> enrolling
  -> ready

any non-revoked state
  -> disabled
  -> ready                 # explicit owner action plus revalidation

any state
  -> revoked
```

`unknown`, `offline`, `auth_failed`, `runtime_incompatible`, and
`rate_limited_unknown` are health classifications, not aliases for
`usage_exhausted`. A profile with one of those classifications is not eligible
as a one-click target.

`usage_exhausted` is also only profile health. A reached preflight may set that
profile state, but it never creates the call-level
`confirmed_subscription_exhausted` evidence required for handoff.

Profile state transitions are serialized by compare-and-swap on profile
generation. A stale login, health check, logout, or handoff completion cannot
overwrite a newer state.

Handoff pair eligibility is a separate derived state machine; ordinary
`ready` never implies handoff eligibility:

```text
pair_unchecked
  -> source_binding_fresh
  -> target_binding_fresh
  -> comparable_accounts_distinct
  -> plan_workspace_approved
  -> attestations_current
  -> policy_tuple_current
  -> pair_eligible

any pair state
  -> pair_blocked
```

Every transition is bound to both profile generations and the current policy
digest. Any missing or changed fact returns the pair to `pair_unchecked` or
`pair_blocked`; cached pair eligibility is never dispatch authority.

## 6. Credential and runtime isolation

### 6.1 Official login seam only

Enrollment invokes only an official Codex authentication seam supported by the
pinned runtime:

- app-server `account/login/start` with `chatgpt` or
  `chatgptDeviceCode`; or
- the documented `codex login --device-auth` command when that CLI seam is the
  approved integration for the supported release.

Browser URLs and device codes are rendered directly for the owner and treated
as ephemeral secrets. Orcode observes only typed completion/cancellation and
sanitized account readiness. It does not scrape a browser, intercept a
redirect, parse the CLI's credential file, read process memory, or copy a token
from another Codex installation.

The official authentication documentation's headless `auth.json` copy
fallback and the app-server's experimental `chatgptAuthTokens` mode are
recognized but intentionally unavailable to this feature. Orcode neither
copies/imports the cache nor takes ownership of the ChatGPT authentication
lifecycle or acts as a token-refresh broker. Each profile must use the managed
login seams above; documented credential portability does not become multi-
account handoff authority.

### 6.2 One isolated Codex home per profile

Every subscription profile gets a canonical, private, Orcode-owned Codex home
that is never shared with another profile or the user's global Codex home. The
runtime launches with only that home and the profile-specific configuration.
It does not inherit global login state, plugins, configuration, shell
credential variables, or an ambient `OPENAI_API_KEY`.

The Codex credential store is configured with the
[`cli_auth_credentials_store = "keyring"`](https://learn.chatgpt.com/docs/auth#credential-storage)
setting documented by Codex authentication where the supported runtime offers
that option. Provider credentials remain owned and refreshed by Codex. Orcode
persists only the non-secret binding metadata in section 5.

The profile home and all parents must be canonical, owner-only, non-symlinked,
non-networked paths. The runtime, config, keyring namespace, and executable are
revalidated immediately before launch. Child processes receive a minimal
environment.

### 6.3 Encryption and isolation release gate

A different `CODEX_HOME` does not by itself prove a different keyring
namespace. Before a platform/version pair is supported, a black-box test must
prove that:

- enrolling profile A never authenticates profile B;
- logging out or revoking A does not alter B;
- account and rate-limit reads are routed to the intended profile;
- concurrent profile runtimes cannot cross-open each other's state;
- no credential lands in plaintext `auth.json`, Orcode state, logs, crash
  reports, exports, terminal capture, or temporary files.

The proof must observe behavior and file/keyring metadata only; it must not
decrypt, dump, or compare provider token values.

If independent keyring isolation cannot be proven on the exact operating
system and Codex version, multi-profile handoff is unavailable there. Orcode
must not fall back to plaintext credential files, token import/export, shared
homes, or manual token paste.

Orcode's own profile metadata, task checkpoints, confirmation grants, and
audit records are encrypted at rest with a per-device master key held by the
operating-system credential store. Encryption does not change the rule that
provider credentials never enter Orcode storage.

## 7. Enrollment, validation, and revocation

Enrollment is always an explicit owner action. Before login, Orcode shows the
new opaque label, target executor, Codex version, isolation status, and the
owner-only boundary. It does not suggest using somebody else's subscription.

After official login completes, Orcode performs bounded, non-model checks:

1. `account/read` confirms `chatgpt` authentication;
2. a profile-binding observation is recorded at its honest strength;
3. `account/rateLimits/read` returns a supported typed payload;
4. runtime/version and credential-namespace isolation remain valid;
5. the selected route/model is compatible with the Orcode adapter.

Only then can the profile become `ready` for ordinary manual use. Plan labels
and quota values are informational, provider-derived snapshots; they are not
authorization by themselves. Handoff eligibility additionally requires the
fresh exact bindings, distinct-account proof, owner attestation, approved
plan/workspace class, and effect-time policy in sections 5.1 and 7.1.

A user-initiated login cancellation is sent through the exact official
`account/login/cancel` handle when available. Orcode waits for terminal
cancellation or times out into `unknown`; it never assumes cancellation while
the login may still be live.

Logout/revocation invokes the official account logout seam in that isolated
runtime, clears Orcode's non-secret binding only after the outcome is known,
and never opens credential files. If the profile is referenced by an active
continuation checkpoint, Orcode first requires an explicit choice:

- keep the profile until the checkpoint is resolved;
- revoke it and mark the checkpoint `blocked_profile_revoked`; or
- discard the checkpoint, then revoke.

### 7.1 Effect-time `ProviderHandoffPolicy`

Every handoff is governed by a tamper-protected
`ProviderHandoffPolicyV1`, separate from ordinary configuration:

```text
policy_id + policy_revision
decision                         # allow | deny
provider_id
source_plan_class + source_workspace_class
target_plan_class + target_workspace_class
region
codex_version_range
terms_document_id + terms_revision + terms_digest
legal_review_revision
effective_at + expires_at
revocation_epoch
signer_key_id + signature
```

The policy is an authenticated Orcode release/compliance artifact verified
against a pinned trust root plus a monotonic local revocation record. It is not
owner-editable configuration. `provider_handoff_policy_digest` identifies the
complete authenticated artifact. A target-bound evaluation separately
materializes the exact provider, source and target account-binding schemes and
digests, the policy's exact plan/workspace classes, executor region, Codex
version, Terms revision, legal-review revision, expiry, and revocation epoch
into a `provider_handoff_evaluation_digest`.

`region` is an exact release-approved compliance region, not a best-effort IP
guess or wildcard. If the owner/account legal region and executor serving
region cannot be mapped to that value through approved non-secret facts, the
policy evaluation is unknown and blocks handoff.

An allow decision exists only after the release gate in section 17.1 has
confirmed the exact combination. Missing, malformed, expired, future,
revoked, wrong-region, wrong-version, wrong-plan, wrong-workspace, or
signature-invalid policy fails closed. The artifact is Orcode's internal gate;
it is not evidence that OpenAI supports pooling or handoff.

An ordinary call may record no policy and remains usable outside this feature.
For handoff, however, the policy digest must already be present in the source
call before its turn begins and is mandatory in the failed call record,
checkpoint, and confirmation grant. A promptable target-bound checkpoint and
its grant also carry the exact same evaluation digest. A safe checkpoint
created before the owner selects among several targets is non-dispatchable;
selecting a target requires a fresh account/plan/workspace read and atomically
publishes a new target-bound checkpoint generation before the prompt can
appear.

Under the same dispatch compare-and-swap that consumes the grant, the executor
revalidates the authenticated policy and evaluation, current clock, revocation
epoch, region, Codex version, exact source and target account/plan/workspace
bindings and owner attestations, the target's fresh available rate-limit
observation, principal and capability epochs, input provenance root, effect
ledger, and checkpoint generation. That validation occurs immediately before
the first target provider byte; the request transport cannot open or write
before the fence succeeds.

Policy expiry or revocation invalidates every open grant even if the owner
already clicked. Its checkpoints transition to
`blocked_policy_invalid_inspect_only`: they may only be inspected or deleted,
not renewed, rebound, exported for dispatch, or sent under a replacement
policy. A new valid policy can govern only a newly eligible terminal failure
and new checkpoint.

## 8. Usage and exhaustion classification

### 8.1 Why generic errors are insufficient

HTTP 429, a timeout, a closed stream, an authentication error, a network
failure, a local budget, or text containing “limit” can have unrelated causes.
Raw message matching is not a safe basis for switching billing identity.

OpenAI's pricing documentation also says usage is task-dependent and an active
turn may be allowed to finish after a limit is reached. Orcode therefore never
preempts or switches a live turn merely because a rate-limit meter approaches
its boundary.

### 8.2 Classifier output

The classifier emits exactly one normalized class:

```text
available
approaching_limit
preflight_subscription_limit_reached
confirmed_subscription_exhausted
provider_rate_limited_unknown
auth_required
network_unavailable
runtime_error
local_budget_blocked
indeterminate
```

It records the typed evidence category, observation time, relevant provider
bucket identifier if documented, and reset time if provided. It does not store
raw provider payloads or messages.

### 8.3 Confirmed exhaustion rule

`confirmed_subscription_exhausted` requires all of this terminal-turn evidence:

- the official app-server reports the turn terminally failed with typed
  `codexErrorInfo = UsageLimitExceeded` or its documented successor;
- a fresh same-profile rate-limit read corroborates that the relevant
  subscription bucket is exhausted through `rateLimitReachedType` or its
  documented successor;
- the failure and corroboration match the exact fresh source account-binding
  scheme and digest, profile generation, plan class, workspace class, runtime,
  provider bucket, and Codex version;
- the failed turn produced no accepted terminal assistant answer.

If the supported provider version cannot supply both typed failure and
fresh matching corroborating bucket state, the result is
`provider_rate_limited_unknown`, not confirmed exhaustion. The owner may retry
later on the same profile or manually choose another provider through ordinary
route selection, but the one-click handoff does not appear.

### 8.4 A reached preflight is wait-only

A fresh `account/rateLimits/read` result that says the included-usage bucket is
already reached before a turn starts is classified
`preflight_subscription_limit_reached`, not
`confirmed_subscription_exhausted`. Orcode may show the reset state and offer
waiting or the ordinary manual route selector. It does not create a handoff
checkpoint or grant, render `Mit Abo 2 fortfahren?`, start or inspect a target
profile, or make any target network call. Because no provider call failed,
there is no failed call for this feature to resume.

Ordinary manual route selection remains outside this handoff protocol. It
creates a separately authorized ordinary call and cannot reuse a handoff
confirmation, retry identity, or claimed lossless continuation.

### 8.5 Explicit negative cases

None of the following can produce the handoff prompt:

- generic HTTP 429 or retry-after alone;
- a raw error string, translated message, or stderr text;
- near-100-percent usage without a reached classification;
- a reached preflight rate-limit observation without a terminal failed turn;
- unavailable or stale rate-limit data;
- local Orcode step, cost, time, or workspace budget exhaustion;
- API key credit or project budget exhaustion;
- authentication failure, account change, suspension, policy refusal, or
  plan-ineligibility;
- network, DNS, TLS, process, app-server, or protocol failure;
- user cancellation;
- a live, streaming, acknowledged, or indeterminate operation;
- an exhausted profile whose reset has merely passed without a fresh official
  observation.

## 9. Safe task continuation checkpoint

### 9.1 A distinct artifact

The existing repository has three related but different persistence concepts:

- transcript checkpoints for conversation rewind;
- `ChangeJournal` checkpoints for file undo;
- crash resume that reconstructs a factual prompt for a new run.

This feature introduces a fourth explicit concept:
`TaskContinuationCheckpointV1`. It references those canonical artifacts but
does not overload or silently reinterpret them.

### 9.2 Checkpoint contents

The encrypted checkpoint contains enough Orcode-owned state to preserve the
logical task without replaying completed work:

```text
schema_version
checkpoint_id
checkpoint_generation
logical_task_id
chat_id
source_run_id
logical_call_id
failed_attempt_id
originating_principal_id
originating_principal_class
principal_epoch
capability_epoch
input_provenance_root
input_provenance_record_refs
owner_adoption_digests
created_at
expires_at?

canonical_owner_id
executor_device_id
workspace_root_identity
workspace_baseline_fingerprint
tracked_file_hashes
current_diff_digest
change_journal_cursor
run_event_cursor
conversation_cursor

original_user_request_reference
attachment_references_and_digests
canonical_orcode_context
completed_model_item_references
completed_tool_results
resolved_approval_records
task_tree_and_plan_state
policy_and_budget_state
usage_and_cost_ledger
external_effect_count
effect_ledger_digest
effect_record_refs
effect_replay_eligibility

source_profile_id
source_profile_generation
source_route_and_model
source_billing_realm
source_account_binding_scheme
source_account_binding_digest
source_account_binding_strength
source_account_binding_observation_id
source_account_binding_observed_at
source_plan_class
source_workspace_class
source_owner_attestation_id
source_owner_attestation_digest
source_owner_attestation_expires_at
failure_phase
normalized_failure_class
typed_evidence_digest
input_digest
provider_acceptance_state
retry_eligibility
provider_handoff_policy_digest
proposed_target_profile_id?
target_profile_generation?
target_account_binding_scheme?
target_account_binding_digest?
target_account_binding_strength?
target_account_binding_observation_id?
target_account_binding_observed_at?
target_plan_class?
target_workspace_class?
target_owner_attestation_id?
target_owner_attestation_digest?
target_owner_attestation_expires_at?
target_credential_namespace_digest?
provider_handoff_evaluation_digest?
```

Large source content and attachments remain in their existing canonical,
owner-protected stores and are referenced by identity plus digest. The
checkpoint includes the exact approved Orcode context needed for continuation,
not an unbounded copy of the workspace.

The target fields marked `?` are allowed only in the initial non-dispatchable
checkpoint while no target has been selected. Every target field and
`provider_handoff_evaluation_digest` is mandatory in the target-bound
generation that can render a prompt or mint a grant. Missing one blocks the
transition; optionality is never a dispatch fallback.

### 9.3 Forbidden checkpoint contents

The checkpoint must never contain:

- access or refresh tokens, cookies, passwords, API keys, authorization
  headers, device codes, or login URLs;
- raw email addresses or provider account payloads;
- raw provider errors or terminal transcripts that may contain credentials;
- hidden chain-of-thought, internal model reasoning, provider caches, or
  provider-owned opaque session/thread state;
- unresolved approval grants that could be replayed for a different action;
- live process handles, sockets, file descriptors, or mutable object pointers.

### 9.4 Checkpoint creation gate

Before the prompt can appear, Orcode must:

1. stop scheduling new work for the logical task;
2. receive the typed terminal `UsageLimitExceeded` state and fresh matching
   rate-limit confirmation required by section 8.3;
3. drain tool, process, stream, approval, and workspace writers;
4. reconcile the run event log and `ChangeJournal`;
5. freeze and verify every input provenance record, principal/capability epoch,
   and any pre-exhaustion owner adoption;
6. inventory every effect from the failed turn and satisfy section 9.5;
7. classify the failed terminal operation as retryable and not indeterminate;
8. snapshot canonical context, task state, workspace identities, exact source
   account/plan/workspace binding, attestation, and active policy digest;
9. atomically encrypt, write, fsync, and publish the checkpoint;
10. read it back through its authenticated schema and digest;
11. bind an eligible target and policy evaluation in a new generation when
    necessary;
12. only then render the handoff action.

A temporary file, partial write, missing fsync, failed authentication tag, or
unreconciled event keeps the task in `checkpoint_failed`. No profile switch or
retry occurs.

### 9.5 Failed-turn external effects

A terminally failed app-server turn can already have run tools or caused
external effects before its final usage-limit error. The default is therefore
`blocked_external_effect`: any effectful filesystem mutation, process launch,
network write, provider/account mutation, remote command, or other externally
observable action from the failed turn blocks handoff.

The only exception is when **every** such effect has a durable canonical
`EffectReplayRecordV1` published before the prompt:

```text
effect_id
logical_call_id + source_attempt_id
canonical_action_digest
reusable_idempotency_identity
effect_scope_and_target_binding
terminal_result_reference + result_digest
dispatch_count
approval_decision_digest + decision_source
record_generation
```

The idempotency identity must be valid across the source and target provider
attempts, not merely within one process or provider thread. The canonical
dispatcher must prove `dispatch_count = 1`, retrieve the authenticated stored
terminal result, and make target replay return that stored result without
opening a process, writing a file, calling a network endpoint, or redispatching
the action. Missing, stale, ambiguous, nonterminal, noncanonical, or
provider-scoped effect records block handoff.

Prior approval does not authorize a second effect. YOLO changes only the
recorded approval decision source; it never relaxes the digest, reusable
idempotency, stored-result, zero-redispatch, or blocking requirements.

### 9.6 Honest meaning of “same task, no context or code loss”

The stable `logical_task_id`, chat, user request, reviewed Orcode conversation
context, completed results, task graph, plan status, budgets, audit lineage,
workspace bytes, and file journal continue unchanged. This is the product
meaning of the same task.

Orcode does not claim that a live Codex provider turn or hidden provider state
continues across accounts. In-process continuation may reuse Orcode's local
objects after validation. After an Orcode restart, or when the target profile
cannot resume the source provider thread, Orcode starts a new provider
execution attempt under the same logical task and supplies the canonical
continuation context from the checkpoint. That attempt may have a new root run
ID under the repository's crash-resume model; the stable `logical_task_id` and
checkpoint lineage are what make it the same product task.

Hidden reasoning, server-side cache residency, and provider-owned opaque
thread state are not transferable and are not counted as Orcode-owned context.
If a task depends on unavailable opaque state, continuation is blocked rather
than falsely presented as lossless.

## 10. Retry and exactly-once semantics

The handoff retries one logical provider call, not the entire run or task.

The source call keeps its `logical_call_id` and `input_digest`. The target
profile receives a new `attempt_id`, a new provider turn identity, and the same
reviewed logical input, immutable input-provenance root, and continuation
envelope. This lineage is persisted before sending any provider bytes.

Orcode must not re-execute:

- completed model calls;
- completed or rejected tool calls;
- file edits already present in the journal and workspace;
- tests, commands, or external actions already terminally recorded;
- approvals already resolved for those exact completed operations;
- plan steps already marked complete.

The new model attempt receives those items as factual prior results. A replay-
safe effect from section 9.5 is supplied only through its authenticated stored
result; the underlying action is not redispatched. Any genuinely new tool call
the target proposes is a new operation subject to current approval, budget,
provenance, and idempotency rules.

Retry is allowed only when the source operation is terminally failed under
section 8.3, produced no accepted terminal assistant result, and has either no
external effect or only the fully replay-safe effects in section 9.5. A
`prepared` operation or reached preflight has no failed call to resume and is
never eligible for this handoff protocol.

An operation in `sent`, `acknowledged`, `streaming`, or `indeterminate` is not
automatically retryable. Orcode first reconciles it to a safe terminal fact. If
it cannot, the checkpoint is `blocked_indeterminate` and requires manual
review. A timeout is never proof that the provider did nothing.

The target send uses compare-and-swap over checkpoint generation and a durable
operation journal. The same dispatch fence covers policy/evaluation digests,
source and target account/plan/workspace bindings, attestations, principal and
capability epochs, input-provenance root, effect ledger, and grant consumption.
Crash recovery reconciles `logical_call_id`, `attempt_id`, provider turn
identity if documented, and terminal state before deciding whether any send is
still allowed.

## 11. One-click owner experience

### 11.1 Prompt eligibility

The exact one-click prompt appears only when all of these are true:

- source usage is `confirmed_subscription_exhausted`;
- the safe checkpoint passed every gate in section 9.4;
- exactly one proposed target is already enrolled and `ready`;
- target and source belong to the same `owner_id` and executor boundary;
- source and target each have a fresh nonoptional `verified_opaque` or
  `derived` account binding under a comparable scheme, and the two exact
  account-binding digests are distinct;
- source and target each have a fresh device-bound owner attestation and exact
  approved plan/workspace class;
- the target is a different isolated profile and credential namespace;
- the target has fresh `available` rate-limit state;
- route, model contract, tools, policy, and task capabilities are compatible;
- the input-provenance root contains no unadopted collaborator input and every
  adoption occurred before the exhausted source turn;
- the failed turn has no external effect or every effect passed section 9.5;
- the authenticated `ProviderHandoffPolicy` and exact target-bound evaluation
  are current for provider, plan/workspace classes, region, Codex version,
  Terms/legal revision, and expiry;
- no billing realm changes from ChatGPT subscription to API key;
- the acting principal is the owner or an authorized owner device;
- no collaborator capability is present in the authorization path.

If several eligible profiles exist, the owner first selects one in the
owner-only profile manager; Orcode then offers one confirmation for that exact
target. Target selection advances the checkpoint to a freshly validated,
target-bound generation before the prompt. It does not automatically rank
profiles by remaining quota.

### 11.2 Copy and actions

The default German interaction is:

```text
Abo 1 ist bestätigt ausgeschöpft.
Sicherer Task-Checkpoint gespeichert.

[Mit Abo 2 fortfahren?]  [Warten]  [Abbrechen]
```

If OpenAI supplies a reset time, Orcode may show it as a provider-derived
estimate. It does not expose raw counters, account email, plan details, or the
existence of other profiles outside the owner-only surface.

`Mit Abo 2 fortfahren?` is one deliberate click, key activation, or equivalent
accessible confirmation. Merely focusing the button, pressing Enter in an
unrelated prompt, reconnecting a device, or timing out cannot confirm it.

### 11.3 Confirmation grant

The click consumes a short-lived, one-use `HandoffConfirmationV1` bound to:

```text
confirmation_id
checkpoint_id + checkpoint_generation
logical_task_id + logical_call_id + input_digest
originating_principal_id + originating_principal_class
principal_epoch + capability_epoch
input_provenance_root + owner_adoption_digests
source_profile_id + source_profile_generation
source_account_binding_scheme + source_account_binding_digest + strength
source_account_binding_observation_id + source_account_binding_observed_at
source_plan_class + source_workspace_class
source_attestation_id + source_attestation_digest + source_attestation_expires_at
target_profile_id + target_profile_generation
target_account_binding_scheme + target_account_binding_digest + strength
target_account_binding_observation_id + target_account_binding_observed_at
target_plan_class + target_workspace_class
target_attestation_id + target_attestation_digest + target_attestation_expires_at
target_credential_namespace_digest
target_rate_limit_observation_id + class + target_rate_limit_observed_at
route + canonical_model + billing_realm
effect_ledger_digest + effect_replay_eligibility
provider_handoff_policy_digest + provider_handoff_evaluation_digest
region + codex_version + terms_revision + legal_review_revision
policy_expires_at + policy_revocation_epoch
owner_id + executor_device_id + confirming_device_id
issued_at + expires_at
```

The executor revalidates every binding under the effect-time dispatch CAS and
consumes the grant atomically immediately before the first provider byte. A
stale generation, changed login/account/plan/workspace, non-distinct account,
expired attestation or policy, revoked policy, changed Terms/legal revision,
changed principal/capability epoch or provenance, changed effect ledger,
second click, different model, changed workspace, or different device produces
no provider call and leaves the task safely paused or inspect-only as section
7.1 requires.

### 11.4 No-ready-target experience

If no enrolled target is ready, Orcode does not turn enrollment into a hidden
one-click side effect. It offers separate owner actions such as:

```text
[Später erneut prüfen]  [Weiteres Abo einrichten]  [Abbrechen]
```

Enrollment completes outside the continuation grant. After successful
validation, Orcode regenerates the checkpoint eligibility decision and asks
for an explicit handoff confirmation.

## 12. Handoff state machine

```text
running
  -> terminal_usage_limit_failure_observed
  -> corroborating_terminal_exhaustion
  -> checkpointing
  -> binding_target_and_policy
  -> paused_awaiting_owner
      -> paused_waiting_reset
      -> cancelled
      -> authorizing_target
          -> paused_stale_confirmation
          -> paused_target_unavailable
          -> retry_bound
          -> effect_time_dispatch_cas
          -> retry_sent
          -> running
          -> completed

preflight_subscription_limit_reached
  -> wait_or_ordinary_manual_route_selection

corroborating_terminal_exhaustion
  -> blocked_unconfirmed_limit

checkpointing
  -> checkpoint_failed
  -> blocked_collaborator_provenance
  -> blocked_external_effect

binding_target_and_policy
  -> blocked_account_binding
  -> blocked_plan_or_workspace
  -> blocked_owner_attestation
  -> blocked_policy_invalid_inspect_only

effect_time_dispatch_cas
  -> paused_stale_confirmation
  -> blocked_policy_invalid_inspect_only

any pre-retry state
  -> blocked_indeterminate
```

Only `paused_awaiting_owner -> authorizing_target` consumes a user
confirmation. No timer, health notification, background job, process restart,
or quota reset may traverse that edge. Only a typed terminal failed turn can
enter `checkpointing`; the preflight state has no edge into any handoff state.
Owner adoption also has no edge from an exhaustion or paused handoff state.

## 13. Failure, cancellation, and recovery semantics

### 13.1 Wait or decline

`Warten` leaves the encrypted checkpoint paused and schedules no provider
call. A later owner action may refresh the source profile's official limit
state. Passing a displayed reset time is not enough; `ready` requires a fresh
typed observation.

Closing the UI, losing the remote connection, or declining the proposed target
also leaves the checkpoint paused. None is interpreted as consent.

### 13.2 Cancel

`Abbrechen` starts a separate explicit choice because cancellation can have
different retention consequences:

- close the continuation but retain the checkpoint for the normal encrypted
  retention period;
- discard the checkpoint and keep the already completed workspace changes;
- use the existing safe undo flow for a completed run's changes, if eligible.

Cancel never invokes a provider. Checkpoint deletion is atomic and auditably
records only the normalized disposition. Undo remains governed by the existing
`ChangeJournal`; cancellation does not silently roll back files.

### 13.3 Target changes after the prompt

If either profile logs out, changes account binding, plan/workspace class,
profile generation, or attestation; or if the target becomes exhausted, is
revoked, changes Codex version, loses keyring isolation, or fails health
validation, the confirmation becomes stale. Orcode sends nothing and returns
to a paused or inspect-only state with a sanitized explanation.

### 13.4 Double activation and concurrent devices

The confirmation grant is single-use and consumed through compare-and-swap.
Two clicks, two owner devices, or a delayed UI event can create at most one
target attempt. Losers receive the already-consumed state and never resend.

### 13.5 Crash boundaries

- Crash before durable checkpoint publication: no prompt is valid and no
  target send is allowed.
- Crash after checkpoint publication but before confirmation: reload the
  authenticated paused checkpoint.
- Crash after confirmation but before durable retry binding: the unused grant
  remains subject to policy, attestation, principal/capability, and grant expiry
  plus CAS reconciliation.
- Crash after retry binding but before send: reconcile the operation journal;
  re-run the complete effect-time dispatch fence and send only if it proves no
  bytes were accepted and every binding is still current.
- Crash during or after send: mark the attempt indeterminate until the official
  runtime and journal produce a safe terminal fact. Never blindly resend.
- Crash after target completion but before UI update: reconstruct completion
  from durable provider/run facts; do not rerun.

### 13.6 Workspace drift

Before retry, Orcode compares the canonical workspace root, tracked file
identities, hashes, current diff, and journal cursor with the checkpoint. Any
unexplained drift blocks the retry. The owner may inspect and create a new
checkpoint after reconciliation; Orcode never overwrites newer work to force a
handoff.

### 13.7 Model or capability mismatch

If the target profile cannot serve the exact canonical model/capability
contract, one-click continuation is unavailable. A model change is a separate
route change with an explicit explanation and approval. It cannot reuse the
old confirmation grant.

### 13.8 Principal, provenance, and compliance invalidation

A principal or capability epoch change, new or altered input provenance,
unadopted collaborator steer, adoption attempted after exhaustion, changed
effect record, policy expiry/revocation, Terms or legal-review revision change,
region change, or unsupported Codex version invalidates every open grant.

Principal/provenance or effect changes leave the checkpoint blocked and require
a new ordinary owner call or a newly eligible terminal failure. Policy expiry
or revocation applies the stricter section 7.1 rule: the checkpoint becomes
inspect/delete-only and can never be dispatched or renewed.

## 14. Collaborators are bring-your-own only

### 14.1 Capability firewall

Collaborator authorization is denied before every one of these boundaries:

- subscription profile listing, count, labels, and status;
- account and rate-limit reads;
- login, logout, enrollment, selection, or confirmation;
- isolated home, keyring namespace, runtime process, or socket access;
- provider request dispatch through an owner profile;
- owner quota, plan, reset, failure, or audit metadata;
- continuation grants and encrypted checkpoint decryption.

This denial occurs before filesystem, keyring, provider-runtime, network, or
side-channel effects. UI hiding alone is insufficient. The authorization check
is applied to every input event and logical call, not merely to the currently
visible session owner. An owner click cannot act as a confused deputy for
collaborator-authored or collaborator-steered work.

### 14.2 Sharing a task or code

The owner may share repository content, a patch, task text, completed results,
or a deliberately sanitized task bundle. Before export, Orcode removes:

- owner and device identifiers;
- profile IDs, labels, counts, binding digests, and isolation metadata;
- route-specific account and quota facts;
- confirmation grants and checkpoint encryption metadata;
- private audit entries and provider-runtime identifiers.

The recipient must bind the imported task to their own provider configuration
before any model call. A missing collaborator provider produces a setup-required
state, never fallback to the owner's executor.

Conversely, a task or steer received from a collaborator retains its
`originating_principal`, principal/capability epochs, authenticated channel, and
ordered input-provenance root when viewed by the owner. It cannot use an owner
subscription merely because the owner opened the task, owns the workspace, or
later sees an exhaustion prompt. Only the separate content-bound adoption in
section 4.4, completed before the source turn, makes those exact bytes eligible
for an ordinary owner call. Adoption and handoff confirmation are never one
combined action or surface.

Every later collaborator steer creates a new provenance record and removes
owner-profile eligibility until separately adopted before a new call. Imports,
forks, summaries, compaction, restart, relay delivery, and remote-device
handoff must preserve this provenance rather than collapsing it into the last
viewer or executor identity.

### 14.3 Relay and same-owner devices

The remote relay design's owner-equivalent personal-device path does not create
a collaborator exception. The executor verifies an enrolled owner-device
principal for every profile action. Shared daemons, public endpoints, team
accounts, anonymous browser clients, and resale services cannot expose this
feature.

## 15. Audit, privacy, and retention

### 15.1 Minimal audit schema

Audit events contain only normalized, non-secret facts:

```text
event_type
timestamp
logical_task_id
logical_call_id
originating_principal_class
principal_epoch + capability_epoch
input_provenance_root
owner_adoption_digest?
checkpoint_id + generation
source_profile_id
target_profile_id?
executor_device_id
confirming_device_id?
effect_ledger_digest
provider_handoff_policy_digest
provider_handoff_evaluation_digest?
normalized_reason_code
operation_phase
outcome
one_way_event_digest
```

Profile identifiers are opaque local IDs. Ordinary logs use the friendly label
only in the private owner UI and do not contain account identity. Account-
binding digests and attestation bodies remain inside encrypted control records;
the audit identifies their evaluated grant/checkpoint rather than duplicating
them.

### 15.2 Data excluded from logs and telemetry

No log, metric, analytics event, crash report, support bundle, export, or test
fixture may contain:

- tokens, cookies, API keys, authorization headers, passwords;
- device codes, login URLs, redirect data;
- raw account email, name, workspace, plan payload, or quota payload;
- prompt/source contents by default;
- raw provider error text or terminal output;
- keyring item values or decryptable credential material;
- collaborator-visible evidence that more owner profiles exist.

Counters may report normalized aggregate outcomes such as
`handoff.confirmed` or `handoff.blocked_indeterminate` without account or task
content.

### 15.3 Retention and deletion

Continuation checkpoints inherit the chat/task retention boundary and are
deleted when the owner deletes the task, subject only to an explicitly stated
short crash-recovery tombstone. Completed and cancelled checkpoints are pruned
under a bounded policy. Confirmation grants expire quickly and are destroyed
after use.

Policy-expired or revoked checkpoints remain encrypted and inspect/delete-only
for the shorter of their normal retention or policy tombstone period. They are
never restored to dispatch eligibility by retention, import, clock rollback,
or installation downgrade.

Profile deletion removes Orcode metadata and invokes official provider logout
as specified in section 7. Encrypted deletion is not represented as provider
account deletion. Exports are redacted by construction and cannot be imported
as owner authorization.

## 16. Security invariants

The following invariants hold across TUI, plain terminal, JSON mode, remote
owner-device UI, restarts, and concurrent processes:

1. Orcode never reads, copies, exports, displays, decrypts, or forwards a Codex
   provider credential.
2. One profile has one isolated runtime home and one proven credential
   namespace.
3. A configuration `--profile` is never treated as authentication isolation by
   itself.
4. Only official login, account, rate-limit, turn, and logout seams are used.
5. A collaborator cannot observe or spend from an owner subscription profile.
6. Every user and steer input retains originating principal, principal and
   capability epochs, and immutable provenance through sharing and resume.
7. Collaborator input requires separate content-bound owner adoption before
   the source turn; exhaustion UI can never adopt it.
8. A profile switch requires a terminal typed `UsageLimitExceeded`, fresh
   matching rate-limit confirmation, a durable safe checkpoint, and one exact
   owner confirmation. A reached preflight or `prepared` call cannot hand off.
9. Source and target have fresh, comparable, nonoptional account bindings that
   are distinct, exact approved plan/workspace classes, and current
   owner-device attestations.
10. No background event can synthesize confirmation or target selection.
11. Only the failed provider call is eligible for a new attempt. A failed turn
    with an external effect is blocked unless every effect has a canonical
    action digest, cross-attempt idempotency identity, and stored-result replay
    with zero redispatch.
12. Indeterminate operations are reconciled or blocked, never guessed safe.
13. The authenticated `ProviderHandoffPolicy` and exact evaluation are checked
    again under dispatch CAS immediately before the first provider byte.
14. Expired or revoked policy invalidates open grants and makes checkpoints
    inspect/delete-only.
15. API-key billing is never substituted for subscription billing without
    separate explicit consent.
16. Hidden provider state is never claimed as transferred or losslessly
    preserved.
17. Unsupported versions, platforms, storage modes, protocol shapes, account
    bindings, plan/workspace classes, regions, or policy states fail
    closed.

## 17. Tests and release gates

This feature remains Preview and disabled by default until every mandatory
gate is green for an exact Codex version and operating system.

### 17.1 Provider-contract gates

- Recheck the official OpenAI authentication, pricing, app-server, and API
  documentation at release time; record document URLs and review date.
- Complete a product and legal review against the then-current official OpenAI
  terms and plan conditions. A technical seam is not permission to aggregate,
  automate, share, or evade subscription controls. Ambiguity about whether the
  manual handoff circumvents a limit fails this gate and keeps the feature off.
- Produce a signed, expiring `ProviderHandoffPolicy` for the exact provider,
  source and target plan/workspace classes, region, Codex range, Terms
  revision, and legal-review revision. Missing policy or a deny decision keeps
  the feature absent; the artifact never claims provider support.
- Pin an allowed Codex version range and reject unknown protocol shapes.
- Black-box `account/login/start`, login cancel, `account/read`,
  `account/rateLimits/read`, rate-limit updates, typed
  `UsageLimitExceeded`, turn terminal events, thread start/resume, and logout.
- Assert that local CLI help still exposes the intended device-login seam and
  never infer a native pool from `--profile`.
- Recognize the documented headless `auth.json` copy fallback and experimental
  app-server `chatgptAuthTokens` mode, then prove that this feature rejects
  both, including externally managed token-refresh requests. The gate records
  this as Orcode policy and never as evidence that the seams are undocumented
  or that they authorize subscription pooling or handoff.
- Contract fixtures contain synthetic typed metadata only, never captured
  credentials or production account payloads.

### 17.2 Credential-isolation matrix

For every supported OS/keyring/Codex tuple:

- enroll A and B independently and prove account/rate-limit routing remains
  isolated without inspecting tokens;
- require fresh comparable `verified_opaque` or `derived` bindings for A and B;
  reject equal digests, incomparable schemes, `profile_only`, missing, unknown,
  stale, or changed bindings before prompt and again before first target byte;
- reject missing, unknown, stale, changed, organization-managed, or nonapproved
  plan/workspace classes for either profile;
- verify owner attestations are device-bound, short-lived, account/plan/
  workspace/profile-generation-bound, tamper-evident, and invalidated by a
  wrong owner/device or principal/capability epoch;
- run both concurrently and under adversarial start/stop ordering;
- logout, revoke, corrupt metadata, and replace one home while proving the
  other remains unchanged;
- reject shared/symlinked/network homes, ambient global login, inherited API
  keys, wrong executable, and wrong OS account;
- scan homes, temp trees, output, logs, events, journals, fixtures, and crash
  artifacts for synthetic credential fragments;
- prove there is no plaintext `auth.json` fallback;
- fail the platform gate if keyring namespace independence is ambiguous.

### 17.3 Classifier matrix

Table-driven tests cover every input and prove only the exact rules in section
8.3 can produce confirmed exhaustion. Negative cases include generic 429,
approaching limit, stale data, contradictory buckets, no corroboration,
auth/policy errors, API credit exhaustion, local budgets, offline runtime,
timeout, stream loss, cancellation, and unknown future enums.

Tests also prove a live turn is never preempted at a meter boundary and that a
passed reset time does not restore readiness without a fresh provider read. A
fresh reached preflight must produce `preflight_subscription_limit_reached`, no
handoff checkpoint or prompt, and zero target-profile runtime or network calls;
only wait and ordinary manual route selection remain.

Positive handoff classification requires one terminal typed
`UsageLimitExceeded` plus fresh matching `rateLimitReachedType` evidence for
the exact source binding, profile generation, plan/workspace, bucket, runtime,
and Codex version. A mismatch in any field is negative.

### 17.4 Checkpoint and exactly-once gates

- schema round-trip and unknown-version refusal;
- a target-unbound checkpoint is inspect/pause-only; target binding atomically
  advances generation and every target/evaluation field becomes mandatory
  before prompt or grant;
- authenticated encryption, owner/device binding, key loss, tamper, truncation,
  stale generation, and wrong-root rejection;
- atomic-write fault injection at every write, rename, fsync, and publication
  boundary;
- tool/process/approval/writer drain and terminal-turn enforcement;
- canonical context, task tree, plan, attachment, budget, usage, event cursor,
  workspace hash, diff, and journal preservation;
- originating principal, every user/steer provenance record, principal and
  capability epochs, adoption digests, source account/plan/workspace binding,
  owner attestation, policy digest, target evaluation digest, and effect ledger
  round-trip without authority widening;
- explicit absence of secrets, raw provider data, and hidden reasoning;
- source states `prepared`, `sent`, `acknowledged`, `streaming`, `terminal`, and
  `indeterminate` across all crash points, with only the exact eligible terminal
  state allowed and `prepared` explicitly denied;
- completed tool/file effects run exactly once;
- default rejection of any failed-turn external effect lacking a canonical
  action digest, cross-attempt reusable idempotency identity, and authenticated
  stored terminal result;
- positive effect replay returns the stored result to the target while process,
  filesystem-mutation, and network dispatch counters remain unchanged;
- a YOLO failed-turn effect has underlying dispatch count exactly one across
  handoff; its synthetic approval never bypasses effect gates and target replay
  increments only the stored-result counter;
- only the failed logical call obtains a new attempt ID;
- crash before/after checkpoint, confirmation, retry bind, send, terminal
  response, context commit, and UI update;
- workspace drift, target re-login, target exhaustion, revocation, model
  mismatch, double-click, concurrent-device, and replayed-grant rejection;
- policy signature/tamper, Terms/legal revision, expiry, revocation, region,
  Codex version, plan/workspace, clock rollback, installation downgrade, and
  dispatch-CAS races immediately before first provider bytes; every failure
  makes zero target calls, and expiry/revocation leaves inspect/delete only;
- in-process continuation and restart continuation both retain the same
  `logical_task_id` while honestly starting a new provider attempt.

### 17.5 UX and accessibility gates

- snapshot and interaction tests for TUI, plain terminal, JSON/event mode, and
  remote owner-device surface;
- exact copy distinguishes confirmed exhaustion, checkpoint success, waiting,
  cancellation, target staleness, and indeterminate blocking;
- `Mit Abo 2 fortfahren?` is one explicit activation, accessible by keyboard
  and screen reader, never triggered by focus or timeout;
- no-ready-target and several-target paths require separate selection/setup;
- `profile_only`, same-account, stale-attestation, unapproved-plan/workspace,
  collaborator-provenance, external-effect, and invalid-policy states never
  render the one-click action;
- reset time is labeled provider-derived and optional;
- no raw account or quota data appears outside owner-only surfaces.

### 17.6 Collaborator abuse gates

Use a capability matrix across local collaborator, remote collaborator, shared
task import, malicious task content, replayed chat link, guessed profile ID,
stolen checkpoint file, changed principal, and confused-deputy executor call.
Every path must fail before profile, keyring, runtime, network, quota, or audit
access. A collaborator recipient's imported task without that collaborator's
BYO provider must remain setup-required; the separate pre-turn owner adoption
path below remains distinct.

Persist and test the originating principal, principal/capability epochs, and
ordered provenance for every user and steer input through import, fork,
compaction, restart, relay, and handoff. Any collaborator input blocks an owner
profile unless a separate owner action adopted those exact content/attachment
digests before the source turn. Adoption after exhaustion, adoption embedded
in the handoff prompt, a later collaborator steer, stale epoch, or changed
digest must produce no prompt, grant, provider runtime, or target network call.

### 17.7 Repository and real-runtime gates

- TypeScript build, production build, full unit/integration suite, privacy
  scanner, package checks, release metadata checks, and existing provider
  regression suites are green.
- Existing OpenRouter, Kimi, single-profile Codex Preview, manual route choice,
  Cross-off-by-default, crash resume, undo, budgets, and remote owner-device
  behavior do not regress.
- Real supported-OS smoke tests use test-owned personal accounts with explicit
  operator consent, sanitized evidence, no credential capture, and no attempt
  to force or manufacture subscription exhaustion.
- Release evidence distinguishes simulated exhaustion from an observed
  provider response. Simulated tests prove logic; they do not prove current
  account limits or provider policy.

## 18. Release posture and compatibility

The feature is visible as **Preview** only on platform/version tuples that pass
all gates and have a current authenticated allow
`ProviderHandoffPolicy` for the exact region and plan/workspace classes. It is
otherwise absent or clearly unavailable; no hidden partial mode remains.

Existing single-profile users are not automatically converted into a profile
set. Migration may create one non-secret local profile record around an
existing isolated Orcode-managed Codex home only if the same credential and
identity gates pass without reading or moving credentials. The user's global
Codex login is never silently adopted.

Provider protocol or documentation drift disables new handoffs until the
contract is revalidated. Policy expiry/revocation or a Terms/legal revision
change invalidates open grants. Affected encrypted checkpoints remain
inspectable and deletable only; they cannot be renewed, rebound, resumed, or
sent through a replacement policy or unsupported runtime.

The public product copy must say that the owner is manually continuing with
another independently authenticated personal profile. It must not advertise
“unlimited,” “combined quota,” “pool,” “rotation,” “load balancing,” or
provider endorsement.

## 19. Non-goals

This design does not provide:

- automatic subscription rotation, failover, round robin, quota optimization,
  or background continuation;
- handoff from a reached preflight, `prepared` call, or any state without a
  terminal typed and freshly corroborated failed provider turn;
- concurrent quota aggregation or combined entitlement accounting;
- sharing, lending, reselling, proxying, or hosting the owner's subscriptions
  for collaborators, teams, tenants, customers, or anonymous users;
- token extraction, import, export, copying, decryption, comparison, or manual
  paste;
- the documented headless `auth.json` cache-copy fallback or experimental
  app-server `chatgptAuthTokens` mode for owner subscription handoff;
- browser cookie reuse or reuse of the user's global Codex credential store;
- a claim that configuration profiles are account profiles;
- handoff for `profile_only`, unknown, stale, same-account, incomparable-
  binding, or nonapproved plan/workspace profiles;
- a claim that technical login continuity proves legal account ownership or
  provider permission;
- API-key fallback disguised as subscription continuation;
- automatic purchase or consumption of credits beyond included plan usage;
- evasion of provider rate limits, policy, suspension, eligibility, or
  anti-abuse controls;
- transfer of provider-owned threads, caches, hidden reasoning, or in-flight
  turns between accounts;
- automatic replay of indeterminate requests or external side effects;
- redispatch of a failed-turn effect, including one approved through YOLO;
- adoption of collaborator input during or after an exhaustion/handoff prompt;
- renewal or dispatch of a checkpoint after compliance-policy expiry or
  revocation;
- cross-owner migration of encrypted checkpoints or profile metadata;
- changing the existing global owner-only provider rule;
- implementing the feature in this document.

## 20. Resolved design questions

This specification intentionally leaves no implementation-driving TBD:

- **Is this a provider-supported subscription pool?** No. It is a manual
  owner-only handoff around documented individual login and runtime seams.
- **Can `--profile` select accounts safely?** Not by itself. Independent homes
  and keyring namespaces must be proven per platform/version.
- **Do documented `auth.json` copying or experimental `chatgptAuthTokens`
  authorize this handoff?** No. They are real credential-portability and
  host-owned-auth seams, but Orcode excludes both from this feature as a
  stricter security and product rule. Neither is a contract for multi-account
  subscription pooling, handoff, or rotation. Every profile uses its own
  Codex-managed official login.
- **Can a 429 trigger the prompt?** No. Section 8.3 requires typed,
  corroborated exhaustion evidence.
- **Can a reached preflight trigger the prompt?** No. Without a terminally
  failed provider call, Orcode can only wait or open ordinary manual route
  selection; it performs no target-profile network operation.
- **Can Orcode switch while a turn is live?** No. It waits for a safe terminal
  fact or blocks as indeterminate.
- **Can `profile_only` or two possibly identical accounts hand off?** No. Both
  sides need fresh comparable `verified_opaque` or `derived` bindings, distinct
  digests, approved exact plan/workspace classes, and current attestations.
- **Does that prove the subscriptions legally belong to the owner?** No. It
  proves continuity to observed logins. A device-bound owner attestation and
  current compliance policy are separate mandatory gates.
- **What is preserved?** All canonical Orcode-owned task context and workspace
  state. Provider-owned hidden or opaque state is neither transferable nor
  promised.
- **What is retried?** Only the one failed logical provider call, with a new
  attempt identity.
- **What if that failed turn already caused an external effect?** Handoff is
  blocked by default. It is allowed only when every effect has a persistent
  canonical action digest, reusable cross-attempt idempotency identity, and an
  authenticated stored result returned without redispatch; YOLO is no
  exception.
- **Who can confirm?** The owner or an enrolled same-owner device acting through
  the owner executor; never a collaborator.
- **Can an owner confirmation launder collaborator input?** No. Every input
  retains principal/epoch provenance. Exact collaborator content must have been
  adopted in a separate owner action before the source turn, never in the
  handoff prompt or after exhaustion.
- **What if the target is unavailable?** The task remains safely paused.
- **When is compliance checked?** The signed policy and exact evaluation are
  checked again under dispatch CAS immediately before the first provider byte.
  Expiry or revocation invalidates grants and makes checkpoints inspect/delete-
  only.
- **Can an API key be used instead?** Only through a separate route and a
  separate explicit billing decision.
- **When can full automation ship?** Only after an official OpenAI contract
  expressly supports it and a new approved design replaces this non-goal.

## 21. Official references

- OpenAI, [Codex authentication](https://learn.chatgpt.com/docs/auth), reviewed
  2026-08-24.
- OpenAI, [Codex basic configuration](https://learn.chatgpt.com/docs/config-file/config-basic),
  reviewed 2026-08-24.
- OpenAI, [Codex pricing](https://learn.chatgpt.com/docs/pricing), reviewed
  2026-08-24.
- OpenAI, [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server),
  reviewed 2026-08-24.
- OpenAI, [API reference overview](https://developers.openai.com/api/reference/overview),
  reviewed 2026-08-24.
- OpenAI, [Europe Terms of Use](https://openai.com/policies/terms-of-use/),
  updated 2026-01-16 and reviewed 2026-08-24.
