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
  and device-code login, and states that the CLI caches one local login's
  details in a file or operating-system credential store.
- [Codex basic configuration](https://learn.chatgpt.com/docs/config-file/config-basic)
  documents the user configuration surface used to require protected
  credential storage and isolated runtime settings.
- [Codex pricing](https://learn.chatgpt.com/docs/pricing) documents that Codex
  is included in eligible ChatGPT plans, that limits are shared and
  task-dependent, and that API-key use is separately usage-based.
- [The Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
  documents `account/login/start`, `account/read`,
  `account/rateLimits/read`, rate-limit notifications, typed turn errors,
  thread start/resume, and turn lifecycle events.
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

As of 2026-08-24, the reviewed public OpenAI documentation exposes no contract
for any of the following:

- aggregating or pooling multiple personal ChatGPT subscriptions;
- automatically rotating among personal subscription accounts;
- transferring a live provider turn, thread, token, cache, or entitlement
  between accounts;
- reading, exporting, or reusing a Codex login token in another runtime;
- treating a configuration profile as an authentication pool;
- lending one person's subscription access to collaborators or remote users.

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
- profile readiness and typed usage-limit classification;
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
- `confirmation_id`: a one-use authorization to resume.

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

## 5. Subscription profile model

Each `OwnerSubscriptionProfileV1` contains only non-secret control metadata:

```text
subscription_profile_id
owner_id
executor_device_id
display_label                 # e.g. "Abo 1", owner editable
codex_home_binding_digest
credential_namespace_digest
codex_version_range
auth_mode                     # chatgpt only
account_binding_digest?       # keyed, never raw email/account text
account_binding_strength      # verified_opaque | derived | profile_only
plan_class?                   # sanitized documented enum, if returned
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

### 5.1 Account binding strength

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

Profile state transitions are serialized by compare-and-swap on profile
generation. A stale login, health check, logout, or handoff completion cannot
overwrite a newer state.

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

### 6.2 One isolated Codex home per profile

Every subscription profile gets a canonical, private, Orcode-owned Codex home
that is never shared with another profile or the user's global Codex home. The
runtime launches with only that home and the profile-specific configuration.
It does not inherit global login state, plugins, configuration, shell
credential variables, or an ambient `OPENAI_API_KEY`.

The Codex credential store is configured with the documented
`cli_auth_credentials_store = "keyring"` setting where the supported runtime
offers that option. Provider credentials remain owned and refreshed by Codex.
Orcode persists only the non-secret binding metadata in section 5.

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

Only then can the profile become `ready`. Plan labels and quota values are
informational, provider-derived snapshots; they are not authorization by
themselves.

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

`confirmed_subscription_exhausted` requires one of these evidence paths:

**Pre-send path**

- the official same-profile `account/rateLimits/read` result says the relevant
  included-usage bucket is reached using the documented provider
  `rateLimitReachedType` classification or its documented successor;
- the observation is fresh and bound to the exact profile/runtime;
- no request bytes were accepted and no provider turn was started.

**Terminal-turn path**

- the official app-server reports the turn terminally failed with typed
  `codexErrorInfo = UsageLimitExceeded` or its documented successor;
- a fresh same-profile rate-limit read corroborates that the relevant
  subscription bucket is exhausted through `rateLimitReachedType` or its
  documented successor;
- the failed operation is known not to have produced an accepted terminal
  answer or an uncommitted external effect.

If the supported provider version cannot supply both typed failure and
corroborating bucket state for the terminal path, the result is
`provider_rate_limited_unknown`, not confirmed exhaustion. The owner may retry
later on the same profile or manually choose another provider through ordinary
route selection, but the one-click handoff does not appear.

### 8.4 Explicit negative cases

None of the following can produce the handoff prompt:

- generic HTTP 429 or retry-after alone;
- a raw error string, translated message, or stderr text;
- near-100-percent usage without a reached classification;
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

source_profile_id
source_route_and_model
source_billing_realm
failure_phase
normalized_failure_class
typed_evidence_digest
input_digest
provider_acceptance_state
retry_eligibility
```

Large source content and attachments remain in their existing canonical,
owner-protected stores and are referenced by identity plus digest. The
checkpoint includes the exact approved Orcode context needed for continuation,
not an unbounded copy of the workspace.

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
2. receive a terminal state for the failed provider turn;
3. drain tool, process, stream, approval, and workspace writers;
4. reconcile the run event log and `ChangeJournal`;
5. prove that completed effects are durably represented once;
6. classify the failed operation as retryable and not indeterminate;
7. snapshot canonical context, task state, and workspace identities;
8. atomically encrypt, write, fsync, and publish the checkpoint;
9. read it back through its authenticated schema and digest;
10. only then render the handoff action.

A temporary file, partial write, missing fsync, failed authentication tag, or
unreconciled event keeps the task in `checkpoint_failed`. No profile switch or
retry occurs.

### 9.5 Honest meaning of “same task, no context or code loss”

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
reviewed logical input plus the continuation envelope. This lineage is
persisted before sending any provider bytes.

Orcode must not re-execute:

- completed model calls;
- completed or rejected tool calls;
- file edits already present in the journal and workspace;
- tests, commands, or external actions already terminally recorded;
- approvals already resolved for those exact completed operations;
- plan steps already marked complete.

The new model attempt receives those items as factual prior results. Any new
tool call it proposes is a new operation subject to current approval, budget,
and idempotency rules.

Retry is allowed only when the source operation state proves one of:

- `prepared`: no request bytes accepted and no worker/provider turn started;
- terminally failed for confirmed subscription exhaustion before any accepted
  assistant result or external effect.

An operation in `sent`, `acknowledged`, `streaming`, or `indeterminate` is not
automatically retryable. Orcode first reconciles it to a safe terminal fact. If
it cannot, the checkpoint is `blocked_indeterminate` and requires manual
review. A timeout is never proof that the provider did nothing.

The target send uses compare-and-swap over checkpoint generation and a durable
operation journal. Crash recovery reconciles `logical_call_id`, `attempt_id`,
provider turn identity if documented, and terminal state before deciding
whether any send is still allowed.

## 11. One-click owner experience

### 11.1 Prompt eligibility

The exact one-click prompt appears only when all of these are true:

- source usage is `confirmed_subscription_exhausted`;
- the safe checkpoint passed every gate in section 9.4;
- exactly one proposed target is already enrolled and `ready`;
- target and source belong to the same `owner_id` and executor boundary;
- the target is a different isolated profile;
- the target has fresh `available` rate-limit state;
- route, model contract, tools, policy, and task capabilities are compatible;
- no billing realm changes from ChatGPT subscription to API key;
- the acting principal is the owner or an authorized owner device;
- no collaborator capability is present in the authorization path.

If several eligible profiles exist, the owner first selects one in the
owner-only profile manager; Orcode then offers one confirmation for that exact
target. It does not automatically rank profiles by remaining quota.

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
source_profile_id
target_profile_id + target_account_binding_digest?
target_account_binding_strength
target_credential_namespace_digest
route + canonical_model + billing_realm
owner_id + executor_device_id + confirming_device_id
issued_at + expires_at
```

The executor revalidates every binding immediately before the send and consumes
the grant atomically. A stale generation, changed login, expired grant, second
click, different model, changed workspace, or different device produces no
provider call and leaves the task safely paused.

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
  -> exhaustion_observed
  -> classifying
  -> checkpointing
  -> paused_awaiting_owner
      -> paused_waiting_reset
      -> cancelled
      -> authorizing_target
          -> paused_stale_confirmation
          -> paused_target_unavailable
          -> retry_bound
          -> retry_sent
          -> running
          -> completed

classifying
  -> blocked_unconfirmed_limit

checkpointing
  -> checkpoint_failed

any pre-retry state
  -> blocked_indeterminate
```

Only `paused_awaiting_owner -> authorizing_target` consumes a user
confirmation. No timer, health notification, background job, process restart,
or quota reset may traverse that edge.

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

If the target logs out, changes account binding, becomes exhausted, is revoked,
changes Codex version, loses keyring isolation, or fails health validation, the
confirmation becomes stale. Orcode sends nothing and returns to a paused state
with a sanitized explanation.

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
  remains subject to expiry and CAS reconciliation.
- Crash after retry binding but before send: reconcile the operation journal;
  send only if it proves no bytes were accepted.
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
side-channel effects. UI hiding alone is insufficient.

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
checkpoint_id + generation
source_profile_id
target_profile_id?
executor_device_id
confirming_device_id?
normalized_reason_code
operation_phase
outcome
one_way_event_digest
```

Profile identifiers are opaque local IDs. Ordinary logs use the friendly label
only in the private owner UI and do not contain account identity.

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
6. A profile switch requires fresh typed exhaustion evidence, a durable safe
   checkpoint, and one exact owner confirmation.
7. No background event can synthesize that confirmation.
8. Only the failed provider call is eligible for a new attempt; completed
   effects are not replayed.
9. Indeterminate operations are reconciled or blocked, never guessed safe.
10. API-key billing is never substituted for subscription billing without
    separate explicit consent.
11. Hidden provider state is never claimed as transferred or losslessly
    preserved.
12. Unsupported versions, platforms, storage modes, or protocol shapes fail
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
- Pin an allowed Codex version range and reject unknown protocol shapes.
- Black-box `account/login/start`, login cancel, `account/read`,
  `account/rateLimits/read`, rate-limit updates, typed
  `UsageLimitExceeded`, turn terminal events, thread start/resume, and logout.
- Assert that local CLI help still exposes the intended device-login seam and
  never infer a native pool from `--profile`.
- Contract fixtures contain synthetic typed metadata only, never captured
  credentials or production account payloads.

### 17.2 Credential-isolation matrix

For every supported OS/keyring/Codex tuple:

- enroll A and B independently and prove account/rate-limit routing remains
  isolated without inspecting tokens;
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
passed reset time does not restore readiness without a fresh provider read.

### 17.4 Checkpoint and exactly-once gates

- schema round-trip and unknown-version refusal;
- authenticated encryption, owner/device binding, key loss, tamper, truncation,
  stale generation, and wrong-root rejection;
- atomic-write fault injection at every write, rename, fsync, and publication
  boundary;
- tool/process/approval/writer drain and terminal-turn enforcement;
- canonical context, task tree, plan, attachment, budget, usage, event cursor,
  workspace hash, diff, and journal preservation;
- explicit absence of secrets, raw provider data, and hidden reasoning;
- source states `prepared`, `sent`, `acknowledged`, `streaming`, `terminal`, and
  `indeterminate` across all crash points;
- completed tool/file effects run exactly once;
- only the failed logical call obtains a new attempt ID;
- crash before/after checkpoint, confirmation, retry bind, send, terminal
  response, context commit, and UI update;
- workspace drift, target re-login, target exhaustion, revocation, model
  mismatch, double-click, concurrent-device, and replayed-grant rejection;
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
- reset time is labeled provider-derived and optional;
- no raw account or quota data appears outside owner-only surfaces.

### 17.6 Collaborator abuse gates

Use a capability matrix across local collaborator, remote collaborator, shared
task import, malicious task content, replayed chat link, guessed profile ID,
stolen checkpoint file, changed principal, and confused-deputy executor call.
Every path must fail before profile, keyring, runtime, network, quota, or audit
access. A shared task without BYO provider must remain setup-required.

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
all gates. It is otherwise absent or clearly unavailable; no hidden partial
mode remains.

Existing single-profile users are not automatically converted into a profile
set. Migration may create one non-secret local profile record around an
existing isolated Orcode-managed Codex home only if the same credential and
identity gates pass without reading or moving credentials. The user's global
Codex login is never silently adopted.

Provider protocol or documentation drift disables new handoffs until the
contract is revalidated. Existing encrypted paused checkpoints remain
inspectable and cancellable but cannot send through an unsupported runtime.

The public product copy must say that the owner is manually continuing with
another independently authenticated personal profile. It must not advertise
“unlimited,” “combined quota,” “pool,” “rotation,” “load balancing,” or
provider endorsement.

## 19. Non-goals

This design does not provide:

- automatic subscription rotation, failover, round robin, quota optimization,
  or background continuation;
- concurrent quota aggregation or combined entitlement accounting;
- sharing, lending, reselling, proxying, or hosting the owner's subscriptions
  for collaborators, teams, tenants, customers, or anonymous users;
- token extraction, import, export, copying, decryption, comparison, or manual
  paste;
- browser cookie reuse or reuse of the user's global Codex credential store;
- a claim that configuration profiles are account profiles;
- API-key fallback disguised as subscription continuation;
- automatic purchase or consumption of credits beyond included plan usage;
- evasion of provider rate limits, policy, suspension, eligibility, or
  anti-abuse controls;
- transfer of provider-owned threads, caches, hidden reasoning, or in-flight
  turns between accounts;
- automatic replay of indeterminate requests or external side effects;
- cross-owner migration of encrypted checkpoints or profile metadata;
- changing the existing global owner-only provider rule;
- implementing the feature in this document.

## 20. Resolved design questions

This specification intentionally leaves no implementation-driving TBD:

- **Is this a provider-supported subscription pool?** No. It is a manual
  owner-only handoff around documented individual login and runtime seams.
- **Can `--profile` select accounts safely?** Not by itself. Independent homes
  and keyring namespaces must be proven per platform/version.
- **Can Orcode copy a login between profiles?** No. Every profile uses its own
  official login.
- **Can a 429 trigger the prompt?** No. Section 8.3 requires typed,
  corroborated exhaustion evidence.
- **Can Orcode switch while a turn is live?** No. It waits for a safe terminal
  fact or blocks as indeterminate.
- **What is preserved?** All canonical Orcode-owned task context and workspace
  state. Provider-owned hidden or opaque state is neither transferable nor
  promised.
- **What is retried?** Only the one failed logical provider call, with a new
  attempt identity.
- **Who can confirm?** The owner or an enrolled same-owner device acting through
  the owner executor; never a collaborator.
- **What if the target is unavailable?** The task remains safely paused.
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
