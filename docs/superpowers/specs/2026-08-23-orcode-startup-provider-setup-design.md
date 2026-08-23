# Orcode Startup and Provider Setup Design

Status: architecture agreed in conversation; written specification awaiting final user review

Date: 2026-08-23

Target: a conversation-first setup foundation for OpenRouter Stable and
ChatGPT-through-Codex Preview, with Anthropic subscription visibly marked
Coming soon

## 1. Context and authority

Orcode currently starts as an OpenRouter-specific application. Credential
loading, model validation, startup status, and agent construction are wired
directly through the OpenRouter service in the CLI. A correct replacement key
can therefore be activated while stale failure messages from an older stored or
environment key remain visible, making a successful paste look rejected.

The 0.7 design already proposes a BackendRegistry and official managed-runtime
adapters, but its startup and Anthropic assumptions are no longer correct:

- it says an existing OpenRouter setup performs no startup probe;
- it presents a Claude subscription as a connectable Preview backend;
- it describes first-run setup as a one-shot multi-select rather than the
  reusable conversation-first setup and repair hub chosen here.

This document is the authoritative amendment for provider setup, account
onboarding, startup health, route activation, and the Anthropic Coming-soon
boundary. It supersedes conflicting statements in section 10.1 and the related
0.7 acceptance bullets of `2026-08-22-orcode-0.7-design.md`. It does not weaken
that design's managed-runtime sandbox, prepared-workspace, patch-transaction,
budget, provider-history, or collaboration safety requirements.

Specifically, 0.7 no longer contains an Anthropic subscription adapter, Claude
login/logout, Claude worker, Claude runtime smoke, or ChatGPT-plus-Claude Cross
gate. Independent read-only discovery of user-authored Claude skill files is a
different feature and is unaffected. The old compatibility sentence forbidding
ordinary startup contact with a new service now means: migration contacts no
service, and startup contacts only providers the user already enabled.

## 2. Product decisions

1. Every ordinary start checks only enabled providers using bounded, non-model
   health operations. Help and version commands never initialize or contact a
   provider.
2. A working saved access path is used without asking the user to enter it
   again. If no enabled route is usable, Orcode opens a reusable setup/repair
   hub instead of exiting the interactive chat.
3. The first public choices are OpenRouter Stable and ChatGPT through the
   official Codex runtime as Preview.
4. Anthropic subscription appears as **Coming soon** and is not selectable.
   Orcode performs no Claude login, token import, runtime launch, or hidden
   eligibility probe for that entry.
5. Claude models remain available through OpenRouter. A direct Anthropic API
   key is a later Advanced feature with separate usage-based API billing; it is
   not part of this initial setup release and is never presented as a Claude
   subscription.
6. One usable provider and one compatible model are sufficient. Multiple
   providers and Cross are optional.
7. Cross is explained during setup but remains off. Setup may remember preferred
   Lead and Challenger routes, but only an explicit `/collab` or `/cross`
   action starts collaboration.
8. Orcode never silently changes backend, account, billing realm, or canonical
   model. A fallback across any of those boundaries must have been explicitly
   configured and is re-confirmed when its billing semantics changed.
9. Existing OpenRouter users migrate without moving or rewriting their saved
   secret and without contacting Codex or Anthropic.

## 3. Scope and non-goals

### 3.1 In scope

- a reusable setup hub for first run, repair, and later account management;
- a backend catalog, backend adapters, setup orchestration, and versioned
  non-secret provider state;
- per-start health classification for enabled providers;
- secure OpenRouter paste, validation, persistence, and stale-environment
  handling;
- official Codex browser/device-code login and account inspection behind a
  visibly Preview adapter;
- route identity that binds backend, account realm, and canonical model;
- provider commands that coexist with today's OpenRouter routing-policy
  subcommands;
- migration and behavioral tests for existing OpenRouter installations;
- a surface-neutral setup event contract reusable by the future remote UI.

### 3.2 Not in scope

- direct Claude subscription login before written Anthropic approval;
- direct Anthropic or OpenAI API-key onboarding in the first setup release;
- copying, parsing, exporting, backing up, or passing provider-owned tokens;
- automatically installing or updating Codex or Claude runtimes;
- silently selecting a paid fallback because another route is offline;
- automatically enabling Cross;
- changing the managed-agent workspace/sandbox design defined by the 0.7 spec;
- claiming that a local fake-runtime test proves authenticated cross-platform
  Codex support.

## 4. User experience

### 4.1 Reusable setup hub

The chosen interaction is a loop of existing single-choice screens, not a new
checkbox/multi-select TUI mode:

```text
Zugänge einrichten
Ein Zugang reicht. Weitere kannst du jederzeit ergänzen.

› OpenRouter                 Stable · API-Guthaben · viele Modelle
  ChatGPT über Codex         Preview · ChatGPT-Konto
  Anthropic / Claude-Abo       Coming soon
  Offline fortfahren
```

After a connection attempt the user returns to the same hub with one current
status per entry. A successful connection replaces prior failure presentation;
the UI never leaves an older red attempt next to a newer successful state.

Anthropic's entry opens an explanation only:

```text
Anthropic / Claude-Abo · Coming soon

Anthropic erlaubt Drittprodukten den claude.ai-Abo-Login nur nach vorheriger
Freigabe. Heute kannst du Claude-Modelle über OpenRouter verwenden.
Ein direkter Anthropic API-Key folgt später unter Advanced.
```

The explanation contains no credential input and triggers no process or network
operation.

### 4.2 Startup outcomes

```text
ordinary start
  -> load and migrate local provider state
  -> inspect enabled providers within independent deadlines
  -> classify current routes

default route ready
  -> open the normal conversation silently

default route ready, secondary route unhealthy
  -> open normally with one compact, dismissible warning

default route unhealthy, another route ready
  -> open conversation with route-choice notice
  -> do not run a model until the user explicitly selects a usable route

no route ready
  -> open the setup/repair hub
```

Cancelling setup in an interactive terminal returns to a persistent
`setup-required` conversation state. Commands that do not require a model remain
available; a model run reopens the setup hub. Orcode does not terminate simply
because setup was cancelled.

Non-interactive prompt and JSON modes never prompt. With no usable explicitly
selected route they return a typed `provider-setup-required` error and a
non-zero exit without printing secret material. `--help` and `--version` bypass
storage migration, runtime detection, and all provider checks.

### 4.3 Model and Cross choice

After the first connection validates, setup loads only compatible models for
that exact backend/account realm. The user confirms a default model before the
candidate setup becomes active. A legacy installation keeps its existing model
when that route remains valid; otherwise setup asks for a replacement.

The final optional screen says:

```text
Cross Mode · optional

Lead entwickelt die Lösung.
Challenger prüft sie unabhängig.

Dafür reichen zwei unterschiedliche Modelle – auch zwei Modelle desselben
OpenRouter-Zugangs.

› Später
  Rollen vorbereiten
```

Both choices leave Cross off. `Rollen vorbereiten` stores only preferred routes.
Cross eligibility requires two different canonical model IDs after exact route
resolution. Two different models from the same family and the same OpenRouter
account are valid; the older 0.7 family-name heuristic and its Advanced override
do not block them. Two routes to the same canonical model ID are not two models.

## 5. Provider and billing-realm matrix

| Entry | Maturity | Credential owner | Billing realm | Initial behavior |
| --- | --- | --- | --- | --- |
| OpenRouter | Stable | Orcode OS keychain or explicit process-only environment key | OpenRouter usage-based account/key | Connectable |
| ChatGPT through Codex | Preview | Official Codex runtime | ChatGPT account; known subscription only when an allowlisted paid plan is reported | Connectable after runtime and policy gates |
| Anthropic / Claude subscription | Coming soon | None in Orcode | None | Explanation only, disabled |
| Claude models through OpenRouter | Stable when the OpenRouter route is usable | Orcode OS keychain | OpenRouter usage-based account/key | Normal OpenRouter model route |
| Anthropic API key | Future Advanced | Future Orcode keychain slot | Anthropic usage-based API | Not implemented by this slice |

Provider allowance, purchased credits, and pay-as-you-go are never collapsed
into one `valid` flag. The UI always qualifies the current realm. Only currently
documented, allowlisted paid `planType` values may be labeled as a subscription.
Free, absent, and unknown/future values are labeled `ChatGPT-Konto ·
provider-managed limits`. The UI never calls unknown usage `$0.00` and never
promises that a subscription cannot use provider-managed overage unless an
official control proves that property.

## 6. Architecture

### 6.1 Backend catalog and registry

`BackendRegistry` contains descriptors independently from connectable adapters.
That distinction permits a truthful Coming-soon entry without shipping a hidden
or partial implementation.

A descriptor declares:

- stable backend ID, display name, maturity, and connectability;
- raw-model or managed-agent kind;
- credential owner and billing-realm kind;
- supported platform/runtime constraints;
- model, modality, tool, reasoning, and usage capabilities;
- safe next actions for every status.

A connectable adapter exposes a small common contract:

```text
inspect(deadline, signal) -> ProviderHealth
connect(interaction, signal) -> CandidateConnection
listModels(candidateOrActiveConnection, signal) -> ModelDescriptor[]
activate(candidate, selectedModel) -> CandidateProviderState
reconnect(deadline, signal) -> ProviderHealth
logout(interaction, signal) -> void
```

Inspection and connection are separate. Startup never calls `connect`.
`AnthropicComingSoonDescriptor` has no adapter, so calling a connection method
is structurally impossible.

### 6.2 SetupOrchestrator

`SetupOrchestrator` owns the startup state machine and candidate transaction. It
does not render a TUI, read a raw secret from configuration, construct an agent,
or execute a model turn. It:

1. loads provider state;
2. asks the registry to inspect enabled entries;
3. reduces the results into one deterministic setup state;
4. emits surface-neutral `SetupEvent` values;
5. accepts explicit setup intents;
6. validates a candidate connection and model;
7. commits the complete candidate state once.

Every orchestration attempt has a generation ID. Late results from a cancelled,
timed-out, or superseded generation are discarded and cannot restore stale UI
errors or overwrite a newer provider state.

### 6.3 ProviderStateStore

Provider state is a versioned, validated section of Orcode's existing private
configuration store, not a second secret database. It contains only:

- enabled/disabled state;
- locally assigned connection alias;
- opaque account fingerprint;
- billing realm and maturity label;
- selected canonical route;
- optional preferred Cross routes;
- last observed health class and timestamp for display only;
- setup schema version.

This section is named independently from the existing `config.provider`
OpenRouter endpoint-routing policy; implementation must not overload or reinterpret
that legacy field.

It never stores an email address, provider access token, browser cookie, raw
account ID, API key, or provider-owned credential path. Last-observed health is
not trusted as startup authorization; enabled providers are inspected again.

Provider state records the identifier of an Orcode-owned credential slot or
dedicated runtime home, never its filesystem path or secret contents. The slot
identifier is an opaque local reference resolved only inside the corresponding
adapter.

### 6.4 Route identity

A runnable route is the exact tuple:

```text
backendId + accountFingerprint + billingRealm + canonicalModelId
```

This is a versioned structured object, not a slash-concatenated string. Model
IDs may themselves contain slashes and are never parsed from display notation.

The account fingerprint is a keyed local HMAC of a provider-documented stable
account/realm field consumed only in memory. An opaque account ID is preferred;
when the official Codex account surface exposes only a stable normalized email,
that value may be HMACed transiently but is never persisted or logged. A locally
generated per-connection ID is used only for a provisional legacy route and
cannot by itself prove account continuity. Display names and raw profile fields
are never persisted identity.

Route equality, fallback, remembered consent, costs, limits, and Cross model
distinctness use this tuple. A shared model slug never makes OpenRouter and
Codex interchangeable.

### 6.5 Surface boundary

The TUI, plain interactive mode, and a future remote dashboard consume the same
versioned setup states, intents, and events. They own presentation and secure
input widgets only. Provider policy remains in the orchestrator and adapters.
No remote relay or UI becomes a credential owner.

## 7. Provider contracts

### 7.1 OpenRouter Stable

The startup adapter uses documented, non-model account/key metadata operations.
It performs no completion and creates no inference cost. `GET /api/v1/key` is
the inference-key authentication authority and exposes key-local limits. The
account-wide `/credits` endpoint is queried only with a management-capable
credential. If `/key` identifies the active inference bearer itself as a
management key, the same bearer may be reused. Otherwise Orcode uses a separately
configured management credential; with neither, it skips `/credits`. Failure of
the management scope never rejects the inference key.

Credential precedence is exact:

1. A saved keychain key is authoritative when present.
2. `OPENROUTER_API_KEY` is ignored as an automatic replacement while a saved
   key exists. The user may explicitly select it from repair/setup.
3. With no saved key, a non-empty environment key may be validated and used for
   that process. It is never persisted automatically.
4. An interactively pasted candidate is normalized and authenticated in memory,
   then staged under a new versioned keychain slot, read back, revalidated, and
   only finally activated. The prior key and configuration remain unchanged
   until the pointer commit succeeds.

This precedence remains true after the saved key is rejected: Orcode opens
repair and may offer the distinct environment candidate, but does not validate
or activate it until the user explicitly selects it. A stale environment value
therefore cannot create a second automatic rejection or replace the saved realm.

Paste normalization removes leading and trailing Unicode whitespace, including
terminal line endings. Remaining embedded whitespace or control characters are
rejected locally, including NUL and ANSI escape bytes. The dashboard and plain
interactive prompt use the same immutable secret-input pipeline. The paste is
handled as one value, never as commands, chat draft, history, or multiple
submissions. Its buffer is discarded after success, error, or cancellation.
Orcode never echoes it or includes it in errors, events, logs, argv, config,
crash reports, or test fixtures.

Only an inference-scoped documented authentication rejection, currently
`GET /api/v1/key` HTTP 401 or an equivalent structured provider auth result,
produces `auth-rejected`. Timeout, rate limiting, DNS/TLS failure, offline state,
HTTP 5xx, and an ambiguous HTTP 403 preserve the key and produce a retryable
connection/policy status. Management-key `/credits` HTTP 401/403 means account
credit is unknown; it says nothing about the inference key. A valid inference
key with a documented exhausted key limit or known zero spendable balance
produces `limit-reached`, not `auth-rejected`. Without authoritative account
credit data, spend remains `unknown` and the UI says so rather than guessing.

If keychain persistence fails after validation, the user may explicitly approve
process-only use. A process-only candidate never changes the persisted provider
route or credential pointer and disappears at process exit. Declining leaves the
old state untouched.

### 7.2 ChatGPT through Codex Preview

The adapter resolves an explicitly supported official Codex executable through
a trusted, workspace-independent path, invokes it without a shell or auto-update,
and communicates with documented `codex app-server` JSON-RPC over local stdio.
Unsupported, unverified, or behaviorally incompatible versions are unavailable,
not best-effort supported. The first Preview uses a connection-specific private
Codex home under Orcode's protected store; it does not inherit the user's global
Codex configuration, plugins, MCP servers, instructions, or login. Reusing a
global Codex home is not part of this release.

Startup inspection is non-billing and bounded:

- verify the resolved executable identity and supported version;
- start the app server with a scrubbed environment and finite deadline;
- use `account/read` without forcing token refresh to inspect login/realm;
- require one successful documented, non-model live authenticated operation,
  initially `account/rateLimits/read`, before deriving `ready`;
- never create a model thread or send workspace/chat content.

A locally present account without a successful live operation is never `ready`.
Authentication expiry or revocation becomes `login-required`; offline/timeout
keeps the dedicated credential home and becomes `offline` or `unknown`. Missing
or unrecognized allowance fields remain spend `unknown` after a successful live
call rather than becoming `$0` or a fabricated paid plan.

Connection begins only after an explicit user action. Orcode uses the official
browser or device-code flow exposed by `account/login/start`. Codex owns,
persists, and refreshes ChatGPT credentials. Orcode persists only its local
connection metadata and opaque fingerprint; it does not use experimental
externally managed token mode.

The adapter accepts only `authMode=chatgpt` for this backend. API-key, personal
access-token, external-token, agent-identity, Bedrock, and unknown auth modes are
different products/realms and remain unavailable here. Before any task content
is sent, the adapter rechecks exact auth mode, local account fingerprint,
allowlisted plan classification, and billing realm against the active route. A
mismatch fails closed with zero task bytes sent and returns to explicit route
confirmation.

Only a currently allowlisted paid `planType` uses the realm
`chatgpt-subscription-provider-managed-overage`. `free`, absent, null, and
unknown or future plan values use `chatgpt-account-provider-managed-limits` and
must not contain `Abo` or `subscription` in current UI or persisted provider
state. Neither realm is called `plan-only` unless an official control later
guarantees that provider-managed overage is impossible. Any transition between
these classifications invalidates prior route consent before task dispatch;
the user must explicitly accept the newly displayed realm before Orcode sends
task content.

The returned browser or device verification URL is treated as untrusted data.
Only HTTPS URLs on the adapter's versioned official OpenAI/ChatGPT host allowlist
may be shown as actionable or opened. HTTP, file, JavaScript, lookalike, embedded
credential, and unexpected hosts are refused. The local callback remains owned
by app-server and is not accepted from arbitrary provider output.

Each login attempt stores its exact `loginId` in ephemeral state. Cancellation
sends `account/login/cancel` for that ID, waits within a finite drain deadline,
and terminates the child if necessary. Cancel, success, timeout, process exit,
and late notification converge on one terminal result. A success arriving after
cancel can never activate provider state.

Disable/disconnect changes only Orcode state. Reconnect runs health operations
only. Logout is separate, requires confirmation every time, waits for an
idle/drained adapter, and affects only the selected Orcode-dedicated Codex home
in this release.

Actual Codex model execution remains subject to every managed-runtime sandbox,
prepared-workspace, nonpersistent-history, patch-validation, budget, and
cross-platform live gate in the parent 0.7 design.

### 7.3 Anthropic subscription Coming soon

Current Anthropic policy says third-party developers may not offer claude.ai
login or rate limits in their products without prior approval, including Agent
SDK-based products. Therefore this release contains only a catalog descriptor
and explanation.

Before the entry can become Preview, a separate approved design and release must:

- record written Anthropic eligibility for Orcode's integration;
- revalidate the then-current official auth and billing contract;
- define credential ownership without token copying;
- pass the parent managed-runtime and platform gates;
- change the descriptor from Coming soon through a reviewed code change.

Installing Claude Code or being logged into it does not authorize Orcode to use
that subscription. Orcode does not detect or display a local Claude login in
this slice.

## 8. Atomic activation and safety

Connection work happens against an in-memory candidate plus provider-owned
temporary login state. Orcode activates only after all of these are true:

1. the adapter and exact runtime are supported;
2. authentication or provider-owned login completed;
3. the billing realm is classified and shown;
4. a compatible canonical model was selected;
5. the route still reports the same account fingerprint and auth mode;
6. the complete provider state validates;
7. one atomic private-store write succeeds.

### 8.1 Credential-slot transaction

Atomicity includes the credential reference. A new OpenRouter secret is written
to a unique versioned keychain account under the existing Orcode service name,
read back, fingerprint-checked, and validated before provider config points to
it. The legacy fixed `inference` account remains readable for compatibility but
is never overwritten as the first step of replacement. The final private-store
commit atomically selects the new slot and route; only afterward may an
unreferenced old slot be removed. Cleanup failure is a visible retention warning,
not rollback of the working new setup.

The legacy fixed `inference` slot is exempt from automatic cleanup through the
declared compatibility window. New slots may be collected only when no committed
or recoverable provider generation references them.

Codex candidates analogously use a new connection-specific private runtime home.
The config commit selects that home by opaque ID. No plaintext secret, login URL,
device code, credential file, or credential-home path enters the transaction
journal. Candidate cleanup operates only on identity-verified Orcode-owned slots
or homes and never on the user's global provider state.

One setup lease plus provider-state generation comparison serializes activation.
Parallel or stale setup attempts fail before pointer commit. Startup recovery
either sees the complete old pointer or the complete new pointer; orphaned
unreferenced candidate slots are quarantined and cleaned through the same
verified private-store boundary.

### 8.2 Time boundaries

Automatic startup inspection has testable wall-clock bounds:

- default per-provider deadline: 5 seconds; configurable hard maximum: 15
  seconds;
- default whole-startup deadline: 8 seconds; configurable hard maximum: 30
  seconds;
- interactive browser/device login wait: 10 minutes by default, capped at the
  smaller of the provider-issued expiry and 15 minutes;
- cancellation/process drain: 5 seconds, then the complete POSIX process group
  or Windows Job Object is force-terminated.

The whole-startup deadline cancels remaining probes and returns the best current
deterministic state. A probe timeout preserves credentials, derives connectivity
`unknown`, and remains retryable. Login timeout cancels the exact `loginId`,
drains the runtime, leaves active configuration unchanged, and returns one
terminal `login-timeout`. Every later result is ignored by generation.

Before the final write, the old saved route, active agent binding, and keychain
secret remain authoritative. A failed validation, cancelled login, model-list
failure, realm change, config-write failure, or process crash cannot partially
enable the new route or erase the previous setup.

Provider-owned effects cannot always be rolled back. In particular, a completed
official Codex browser/device login may remain in an uncommitted dedicated
candidate home after the user cancels Orcode setup or Orcode's final config
write fails. Orcode must not mark the backend enabled. After the app-server is
drained, that identity-verified Orcode-owned candidate may be quarantined and
removed; the user's global Codex login is never touched.

No active run is rebound. Provider activation, disabling, logout, and default
route replacement require the related adapter to be idle and drained. A
candidate that becomes stale while the user chooses a model must be reinspected
before commit.

## 9. Status and error semantics

Provider health is structured, not one trusted enum. It independently records:

- credential: `valid`, `rejected`, `expired`, `login-required`, `unknown`, or
  `not-applicable`;
- connectivity: `connected`, `offline`, or `unknown`;
- spend/allowance: `available`, `limit-reached`, or `unknown`;
- runtime: `ready`, `missing`, `incompatible`, `policy-unavailable`, or
  `not-applicable`;
- observation time and generation.

Three layers form the displayed state:

1. catalog availability: `connectable` or `coming-soon`;
2. local configuration: `enabled` or `disabled`;
3. for an inspected enabled adapter, one derived headline:

- `ready`
- `login-required`
- `auth-rejected`
- `credential-expired`
- `offline`
- `limit-reached`
- `runtime-missing`
- `incompatible-runtime`
- `policy-unavailable`
- `unknown`

Disabled and Coming-soon entries are never inspected and therefore never fake a
health result. Each displayed state carries a safe human explanation,
retryability, and allowed next actions. It never carries raw provider output by
default. Unknown and connectivity failures never become authentication rejection
by string matching.

`ready` requires valid credentials, connected transport, and a ready or
not-applicable runtime. Known `limit-reached` blocks a run. Unknown spend does
not invent a positive balance: the route may remain runnable with an explicit
`Guthaben unbekannt` qualifier, and the provider may still reject the later
model request. No derived headline erases its underlying dimensions.

For OpenRouter, `/key` HTTP 200 with an `expires_at` strictly before the current
trusted clock derives `credential-expired`. It blocks runs and offers repair but
does not delete or relabel the saved key as rejected. Missing or future expiry
does not create this state.

The UI maintains exactly one current card per provider and generation. Starting
a new attempt marks the old result historical and removes it from the active
status area. Success clears the current error. Historical diagnostics may be
viewed separately with secrets centrally redacted; they are never interleaved
with the new success banner.

If the default route is unhealthy while a different route is ready, the chat
opens but no model action silently changes realms. The user may choose the ready
route for this run or make it the new default. If a healthy default exists, a
broken secondary provider never blocks ordinary work.

## 10. Commands and compatibility

The setup hub is available at `/provider setup`. New account/backend subcommands
are:

- `/provider connect <backend>`
- `/provider enable <backend>`
- `/provider disable <backend>`
- `/provider reconnect <backend>`
- `/provider status`
- `/provider models <backend>`
- `/provider logout <backend>`

`disconnect` remains an alias for `disable`; it never logs out of a provider.
`logout` is always confirmed and never remembered.

Today's `/provider sort|allow|deny|only|ignore|fallback|clear` subcommands remain
the OpenRouter endpoint-routing policy and keep their meanings. `/provider`
without arguments preserves its existing routing-summary output;
`/provider status` presents backend/account state. Existing scripts using the
old command or subcommands do not change behavior. `/key` continues to manage
OpenRouter API-key credentials only.

The command catalog, help, completion, dispatch, TUI special handling, and README
are generated or resolved from the same command definitions. `Coming soon` is
presented consistently in setup and documentation without advertising a working
Claude login.

Explicitly disabling the final enabled backend is allowed only after a warning
that model runs will stop. The conversation remains open in `setup-required`,
and the default route is cleared atomically rather than left dangling.

## 11. Migration and compatibility

The provider-state migration is versioned, validated, idempotent, and atomic.

- Existing legacy OpenRouter configuration creates an enabled OpenRouter
  connection without migration reading, moving, or rewriting the keychain.
  The subsequent ordinary startup inspection resolves and reads the retained
  legacy key slot through the adapter.
- Existing main, fallback, compressor, transcription, panel, session-model,
  per-model reasoning, provider-routing, budget, and chat preferences remain
  intact. Every legacy model reference maps losslessly to a structured candidate
  with backend `openrouter`, the migrated local account fingerprint, realm
  `openrouter-payg`, the exact legacy requested model ID, and
  `resolutionState=legacy-unverified` before any network operation. The first
  ordinary model-catalog inspection resolves its canonical ID. A compatible
  result is committed; a missing or incompatible result asks for an explicit
  replacement instead of guessing.
- Legacy `config.provider`, including `allowFallbacks`, remains only OpenRouter's
  internal endpoint-routing policy. It never authorizes a Codex, account, or
  billing-realm transition.
- Migration creates and persists the legacy connection's opaque local ID from
  CSPRNG. It does not derive identity from, hash, or inspect the raw key.
- That local ID is explicitly provisional. The first authenticated provider
  inspection replaces it atomically with the adapter-derived HMAC before the
  route can run; an account mismatch opens repair instead of rebinding silently.
- The current OpenRouter main route becomes the default when it remains
  compatible; otherwise setup requests an explicit model choice.
- An environment-only OpenRouter key remains process-local and is not silently
  copied into the keychain.
- The legacy saved management-key slot remains readable and unchanged. A
  process-only `OPENROUTER_MANAGEMENT_KEY` is never persisted automatically.
  Rejection or absence of either management credential changes only account
  credit visibility, never inference-key validity.
- Codex and Anthropic remain disabled after migration. Migration performs no
  executable discovery, provider login, runtime launch, or network call.
- The first ordinary post-migration startup checks the enabled OpenRouter route.
  This deliberately supersedes the old 0.7 statement that an existing
  OpenRouter configuration performs no probe.
- Running migration or startup repeatedly is state- and byte-stable apart from
  an explicitly updated last-health timestamp after a real inspection.
- Unknown future setup schema versions block provider mutation and are never
  replaced with defaults.
- `never-configured`, `cancelled/setup-required`, `migrated`, `configured`,
  `corrupt`, and `future-version` are distinct persisted or derived states.
  Corrupt and future-version state never masquerades as a clean first run and is
  not overwritten by the wizard.

The existing `routercode` command alias, app-home selection, OS keychain service
names, config path, chats, and non-provider local state remain compatible.

## 12. Privacy and observability

Setup emits typed, redacted events for inspection start/end, current provider
status, user-visible next action, candidate activation, and terminal failure.
Events contain backend ID, maturity, safe account fingerprint, billing-realm
kind, operation/generation ID, duration, and normalized status. They do not
contain secrets, login URLs after their immediate secure presentation, device
codes after expiry, email addresses, raw account IDs, provider response bodies,
or credential paths.

Login URLs and device codes are short-lived secure-display values. They are not
written to chat history, run logs, analytics, shell history, or remote relay
mailboxes. Cancellation invalidates the local attempt and drains its process;
late completion cannot activate an account.

No telemetry or hosted account is introduced. A future remote surface may show
normalized provider status but may not collect a secret or initiate a global
provider logout unless a separately approved remote-security design explicitly
authorizes that intent.

## 13. Implementation slices

This architecture ships in independently reviewable slices:

1. **Foundation and OpenRouter setup:** BackendRegistry contracts,
   SetupOrchestrator, versioned provider state, migration, reusable hub,
   OpenRouter health/paste fixes, route identity, command compatibility, and the
   Anthropic Coming-soon descriptor.
2. **Codex Preview connection:** trusted runtime resolution, allowlisted
   app-server adapter, official login/account flows, model discovery, realm and
   usage presentation, and all parent managed-runtime gates.
3. **Surface reuse:** expose the already-versioned setup state/events through
   OrcodeCore for the future remote dashboard without changing credential
   ownership or startup policy.

Slice 1 is useful and releasable without Slice 2. Slice 2 cannot be advertised
as supported on a platform until its real authenticated live gate passes there.
Anthropic subscription is not an implementation slice; it remains Coming soon
until the policy prerequisites in section 7.3 are met.

After final approval of this architecture, the first implementation plan covers
Slice 1 only. Codex Preview receives its own later plan and review gate after the
foundation is integrated and releasable; the three slices are never one
monolithic implementation task.

## 14. Acceptance gate

### 14.1 Startup and orchestration

- `--help` and `--version` perform zero storage migration, executable discovery,
  provider process launch, keychain read, or network call.
- Startup inspects only enabled providers, with independent finite deadlines and
  an overall finite deadline and cancellation. One stalled adapter does not
  suppress a healthy one. Disabled and Coming-soon entries receive exactly zero
  executable resolution, child process, login, credential, or network calls.
- A healthy default opens silently. A failed secondary produces one compact
  warning and does not block. A failed default never silently switches to a
  healthy route in another realm.
- Zero usable routes opens repair interactively; cancellation leaves the chat
  alive in `setup-required`. Non-interactive modes return the typed error.
- Generation-race tests deliver old failures and successes after a newer attempt
  and prove that only the newest generation can update current UI or state.
- No startup health operation creates a model request or provider usage charge.
- Fake-clock boundary tests prove the 5-second provider, 8-second startup,
  10-minute login, 15-second/30-second configurable maxima, and 5-second drain
  contracts. Each path returns by its bound, terminates its complete process
  group or Job Object, and rejects late state changes.

### 14.2 OpenRouter credentials

- Matrix tests cover valid, rejected, expired, limit-reached, HTTP 403, HTTP 429,
  HTTP 5xx, DNS/TLS failure, offline, timeout, and cancelled inspection across
  independent credential/connectivity/spend dimensions.
- `/key` 401 is the only inference-auth rejection. `/credits` 401/403/5xx and a
  missing management credential leave inference validity unchanged and report
  account spend as unknown.
- A management-capable inference key reuses its bearer for `/credits`; a normal
  inference key without a separate management credential never calls that
  endpoint. Saved and process-only management-key migration retains the declared
  precedence without copying either key.
- `/key` 200 with past, future, and missing `expires_at` values yields expired,
  valid, and valid credential dimensions respectively. Expired blocks runs but
  remains stored for explicit repair/replacement.
- Paste tests cover bracketed paste, CRLF/LF, leading/trailing Unicode whitespace,
  embedded whitespace/NUL/ANSI/control rejection, one later submission, masking,
  and no secret bytes in output or event logs through both real PTY and plain
  interactive paths. Locally rejected bytes cause zero network/store calls.
- A valid saved key plus a stale environment key remains ready with no fallback
  validation, no red error, and no saved-state mutation.
- With no saved key, a valid environment key stays process-local. It is never
  persisted without an explicit later save action.
- A rejected candidate, keychain failure declined by the user, config-write
  failure, cancellation, and crash leave the prior secret and route unchanged.
- Fault injection after candidate validation, keychain write/readback, model
  list, selection, config temp-write, atomic replace, pointer commit, and cleanup
  yields exactly the old or new credential-route tuple after restart, never a
  mixed tuple. Parallel activation loses as stale instead of overwriting.
- Credential scanner and adversarial error fixtures find no complete or partial
  provider secret in UI, logs, config, argv, reports, or committed fixtures.

### 14.3 Codex Preview

- Fake app-server contracts cover missing executable, workspace/PATH impostor,
  unsupported version, malformed JSON-RPC, logged-out, browser login, device
  login, cancellation, realm change, limit reached, offline, timeout, late
  completion, reconnect, logout, and clean process drain.
- Auth fixtures cover `chatgpt`, `apikey`, external token, personal access token,
  agent identity, Bedrock, and null; only `chatgpt` is eligible. A realm change
  after startup fails before sending any prompt bytes.
- A locally recorded ChatGPT account with expired or revoked server auth never
  becomes ready: the required live authenticated call fails, sends no task bytes,
  and preserves the dedicated home. Offline behaves likewise without logging out.
- Plan fixtures cover currently allowlisted paid values, `free`, null, and an
  unknown future value. Only allowlisted paid values receive a subscription
  label and `chatgpt-subscription-provider-managed-overage`. The other values
  receive `chatgpt-account-provider-managed-limits` and contain neither `Abo`
  nor `subscription` in current UI or persisted provider state. None silently
  receives `plan-only`.
- Paid-to-free, free-to-paid, null-to-known, and known-to-unknown plan changes
  invalidate prior realm consent. They fail before sending task bytes and
  require explicit confirmation of the new realm before dispatch can resume.
- Login-order tests cover every ordering of cancel, success, timeout, process
  exit, and late notification with one terminal state, exact-ID cancellation,
  no post-cancel activation, and no orphan process. URL tests refuse non-HTTPS,
  file/JavaScript, lookalike, embedded-credential, and unlisted hosts.
- Startup account inspection creates no model thread and sends no workspace,
  chat, prompt, attachment, or tool content.
- Orcode never reads, copies, exports, persists, prints, or passes ChatGPT tokens
  in argv or child environment.
- Disable and reconnect leave the selected Orcode-dedicated Codex login
  unchanged. Logout is separately confirmed and affects only that dedicated
  home; fixtures prove the user's global Codex state is untouched.
- App-server and worker environments omit OpenAI API keys, Codex access tokens,
  Bedrock/AWS credentials, gateway variables, and inherited plugin/MCP/config
  roots. Returned email, account ID, and workspace name never enter config,
  events, or logs.
- Fresh authenticated normal-exit and forced-crash smokes on every claimed
  platform satisfy the parent 0.7 sandbox/history/patch gates before that
  platform is advertised.

### 14.4 Routes, migration, and UI

- Route tests prove that identical model slugs in OpenRouter and Codex are
  different billing routes and cannot silently substitute for one another.
- Cross remains off after first run, repair, adding a second provider, preparing
  roles, migration, restart, and provider reconnect.
- Existing OpenRouter-only fixtures migrate without secret movement, preference
  loss across main/fallback/compressor/transcription/panel/session/reasoning
  fields, Codex/Anthropic contact, or a second-run diff.
- `/provider` legacy routing-policy subcommands retain exact behavior while new
  setup/account subcommands resolve from the shared command catalog.
- Bare `/provider` preserves its existing routing-summary output byte-for-byte;
  backend/account display is explicit `/provider status`.
- Legacy `provider.allowFallbacks=true` plus a later Codex connection remains an
  OpenRouter-only endpoint policy. Backend/account/realm fallback fails before
  request unless that exact route transition was explicitly configured.
- TUI snapshots at narrow and wide terminals show one current provider state,
  remove stale errors after success, keep the conversation open after setup
  cancellation, and render Anthropic as disabled `Coming soon`.
- Selecting or inspecting Anthropic, and every
  `connect|enable|reconnect|logout|models anthropic` command, causes zero login
  prompt, key input, child process, credential read, provider network request,
  or state mutation.
- `/provider connect anthropic`, keyboard selection, mouse selection, ordinary
  startup, and remote rendering all produce the same Coming-soon explanation.
  Interactive surfaces remain successful and usable; non-interactive connection
  attempts return a typed `provider-coming-soon` result without side effects.
- Disabling the last backend clears the default route and enters
  `setup-required` only after confirmation; cancellation is byte-identical.

## 15. Primary references

- OpenRouter current-key metadata and authentication errors:
  https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
- OpenRouter account credits and management-key requirement:
  https://openrouter.ai/docs/api/api-reference/credits/get-credits
- OpenRouter model catalog:
  https://openrouter.ai/docs/guides/overview/models
- Codex authentication modes:
  https://learn.chatgpt.com/docs/auth
- Codex app-server account, login, and rate-limit methods:
  https://learn.chatgpt.com/docs/app-server
- Anthropic Agent SDK third-party login restriction:
  https://code.claude.com/docs/en/agent-sdk/overview
- Anthropic API-key quickstart:
  https://code.claude.com/docs/en/agent-sdk/quickstart
