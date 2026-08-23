# Orcode Remote Relay Design

Status: architecture agreed in conversation; written specification awaiting final user review

Date: 2026-08-23

Target: post-0.7 remote-control product line, beginning with a separately releasable remote-foundation slice

## 1. Context

Orcode is currently a local, conversation-first coding CLI. The 0.7 design
deliberately excludes a daemon, hosted backend, cloud chat sync, worker service,
and distributed execution. It already defines the boundary a remote surface
needs: one `OrcodeCore` that accepts versioned `CoreIntent` values and emits
versioned, ordered `CoreEvent` values. That boundary is planned but not yet
implemented.

The remote feature therefore starts after the local 0.7 contract instead of
silently expanding 0.7. It must first finish the reusable Core/Event seam, then
add a portable relay, execution-node runtime, and installable web app without
moving policy or workspace authority into the cloud.

The product decision is:

- a phone can send prompts, watch status and live run activity, cancel a run,
  and answer the same approval question as the terminal;
- the same dashboard can connect to multiple managed and self-hosted relays;
- a machine may independently have the Relay, Execution Node, and Workspace
  Host roles;
- coding on a relay machine is supported by running a separate Executor on that
  machine;
- managed and self-hosted modes use the same relay protocol and service image;
- self-hosted mode has no dependency on an Orcode cloud account;
- the relay data plane, acting only as a relay and without control of a trusted
  endpoint build/origin, never receives decryptable task, source, output,
  approval, or workspace data; continuing PWA-origin trust is defined in 8.3;
- a chat is always bound to one exact execution node and workspace at a time;
- normal chats ask for approval, while per-chat YOLO automatically approves
  actions until the user explicitly turns it off.

This is an architectural program, not one safe monolithic patch. Sections 17
and 18 split it into independently testable releases. Each slice gets its own
implementation plan and may ship only when its own gates pass.

## 2. Goals

1. Let a user continue an Orcode chat from a phone without requiring Tailscale,
   while keeping the local terminal usable at the same time.
2. Give managed-relay convenience and fully independent self-hosted deployment
   from one protocol and codebase.
3. Let an SSH-registered Linux machine become a relay, an executor, or both.
4. Keep the executor as the only owner of workspaces, provider credentials,
   canonical chat state, policy decisions, run logs, and tool execution.
5. Preserve exact approval subjects, budgets, sandboxing, redaction, one-writer
   rules, run cancellation, and verification behavior across every surface.
6. Use application-level end-to-end encryption so TLS termination, relay
   storage, and administrators acting only through the relay data plane cannot
   decrypt content. Endpoint and PWA-publisher trust remains explicit.
7. Make reconnects, duplicate delivery, event replay, revocation, and crash
   recovery explicit protocol behavior rather than UI guesses.
8. Keep the mobile product useful without becoming a remote desktop, generic
   SSH terminal, or browser IDE.

## 3. Non-goals for the first release

- No collaborative teams, shared organizations, public links, or guest access.
- No arbitrary terminal emulator, desktop streaming, or remote file editor.
- No automatic selection of a node or workspace from a prompt.
- No transparent movement of a running chat between nodes.
- No delayed execution of phone commands while the target executor is offline.
- No full opaque SDK-state or complete source-history transfer during handoff.
- No mobile image/file upload in the first vertical release.
- No executor inside the relay process and no relay access to workspace mounts,
  provider keys, Docker sockets, or approval state.
- No native macOS or Windows public-relay service claim in v1. Those systems may
  run local executors after their own tested service packaging exists.
- No automatic NAT traversal claim. A self-hosted public relay requires a
  reachable HTTPS endpoint; CGNAT needs a public VPS or a separately disclosed
  third-party tunnel.
- No claim of full forward secrecy, post-compromise security, traffic-analysis
  resistance, or availability against a malicious relay in the HPKE MVP.
- No background executor or relay is installed without an explicit role choice
  and an exact, visible administrative action.

## 4. Considered architectures

### 4.1 Chosen: portable blind relay plus outbound executors

The phone and every executor maintain outbound `wss://` connections to a small
`orcode-relay`. The relay routes opaque encrypted envelopes and bounded offline
mailboxes. The executor owns Orcode Core and all plaintext. The same relay image
runs in the managed service or on a public Linux server.

This is the only approach that gives managed convenience, self-host parity,
NAT-friendly executor connections, coding on a hybrid relay host, and a blind
relay-data-plane boundary without exposing an executor port.

### 4.2 Rejected: expose each executor directly

This removes a service, but requires public ports, DNS, TLS, firewall changes,
and NAT handling on every coding machine. It also makes one mobile dashboard,
offline event delivery, and presence substantially harder. It remains a useful
local-development transport, not the production architecture.

### 4.3 Rejected: cloud-only control plane

A conventional hosted API would be quicker to prototype, but it would make
self-hosted mode a second-class fork and invite chat, key, and policy ownership
into the backend. Hosting is an adapter around the portable relay, never the
source of product semantics.

## 5. System boundaries

```text
apps/remote-web
  -> packages/remote-protocol
  -> packages/remote-e2ee

packages/remote-executor
  -> OrcodeCore
  -> packages/remote-protocol
  -> packages/remote-e2ee

packages/remote-relay
  -> packages/remote-protocol outer-envelope types only

root orcode CLI
  -> src/core.ts and src/events.ts
  -> local authenticated Core socket when remote mode is enabled
  -> src/remote/ssh-bootstrap.ts
```

### 5.1 Orcode Core

`OrcodeCore` is the sole business owner. Plain mode, JSON mode, the terminal
dashboard, and the remote executor all use the same `CoreIntent` and `CoreEvent`
API. Existing `OrcodeAgent`, `SessionStore`, `ConversationStore`, `WorkspaceGuard`,
`ApprovalManager`, `RunLog`, SSH, browser, verification, and model adapters stay
behind Core.

Every event has a protocol version, scope, timestamp, process sequence, and
typed payload. Run events additionally have the stable `runId` and a strictly
increasing run-local sequence. The remote protocol wraps these events; it does
not invent a second run lifecycle.

When remote mode is disabled, the existing CLI may host Core in-process. When
remote mode is enabled, `orcode-executor` is the sole Core owner for that
app-home/workspace and holds a single-runtime lease. Local plain/JSON/TUI
surfaces attach to it through a user-only authenticated Unix-domain socket or
Windows named pipe; they never construct a second agent, approval manager, or
session writer. The local endpoint uses OS access controls plus a random
PrivateStore challenge token, rejects a second executor, and is unavailable to
other users. Phone and terminal therefore observe the same event sequence,
cancel state, and approval broker.

### 5.2 Remote protocol

`packages/remote-protocol` contains browser-safe TypeScript and Zod schemas for
IDs, role grants, pairing, envelopes, sequence/acknowledgement state, node and
workspace inventory, Core intents/events, approvals, snapshots, and errors. It
has distinct `outer` and `inner` package exports. `outer` has no dependency on
Core or inner payload schemas and is the relay's only allowed protocol import.
The package has no Node filesystem, OpenRouter, workspace, or relay-store
imports. A dependency-boundary test rejects forbidden relay imports.

Unknown message versions are rejected. An endpoint supports the current and
immediately previous protocol version; downgrades are visible and may never
silently remove a security field.

### 5.3 Remote E2EE

`packages/remote-e2ee` is imported only by the PWA and executor. The relay may
import the outer-envelope schema but cannot import encryption/decryption APIs.
Crypto primitives are never implemented locally.

### 5.4 Executor

The executor is a long-running Node process on the machine that owns the
workspace. It opens an outbound relay connection, decrypts controller messages,
validates chat/node/workspace binding, submits `CoreIntent`, and encrypts
resulting `CoreEvent` values. It owns controller authorization, idempotency,
sequence windows, key epochs, and event replay.

### 5.5 Relay

The relay owns TLS termination, connection presence, opaque mailbox routing,
quotas, ciphertext retention, generic push notifications, and operational
health. It has no workspace or Orcode Core dependency. Its database never
contains plaintext commands, paths, chat titles, output, model/cost data,
approvals, or YOLO state.

### 5.6 PWA

The mobile-first PWA is an Orcode surface. It renders decrypted inventory,
chats, events, run status, approvals, and a composer. It does not execute tools
or decide policy. One selected home-origin installation stores multiple relay
profiles locally and connects directly to each configured relay.

## 6. Node roles and coding on the relay

A registered machine may have any combination of:

- `relay`: public ciphertext router and mailbox;
- `executor`: Orcode Core endpoint that runs chats and tools;
- `workspace-host`: exposes an explicit allowlist of workspace roots to its
  local executor.

A hybrid machine runs at least two processes:

- `orcode-relay` under a restricted service account, with no workspace mounts,
  provider credentials, device private keys, or Docker socket;
- `orcode-executor` under the dedicated coding account, advertising only the
  configured workspace roots and opening an outbound connection to the relay.

Loopback relay traffic remains application-encrypted. Process separation
contains a relay-service compromise, not malicious host root. “Code on the
relay” always means selecting that machine's Executor role; the relay process
never executes code.

The executor exposes only configured workspace roots through Orcode's built-in
workspace capabilities. This is a logical allowlist, not a false sandbox claim:
an approved arbitrary shell command retains the authority of the executor OS
account. Hybrid installation therefore uses a dedicated coding account with no
access to relay storage, relay credentials, provider secrets outside its own
store, Docker socket, or unrelated service accounts. Stronger per-workspace
container/OS sandboxing is a later profile, not implied by the root selector.

Role changes are owner-authenticated administrative operations. A node cannot
promote itself. YOLO is chat-scoped and never auto-approves enrollment,
revocation, relay-role changes, or service installation outside that chat.

## 7. Identity and pairing

### 7.1 Identities

- Every executor and controller has a long-lived HPKE identity keypair.
- `nodeId`, `controllerId`, mailbox IDs, and peer hints are random or derived
  from public-key fingerprints; human labels remain encrypted.
- Each workspace has a random `workspaceId` plus an executor-computed
  fingerprint over the node identity, workspace ID, and canonical root.
- Managed relay accounts, billing, or rate limits are transport concerns. They
  never replace cryptographic device identity. Self-host mode requires no
  Orcode account.
- All controllers paired through the local/SSH QR flow are owner-equivalent in
  v1. Viewer, guest, and restricted-controller roles are deferred rather than
  implementing an incomplete authorization hierarchy.

### 7.2 Pairing flow

1. The executor creates a CSPRNG 256-bit invite ID and independent 256-bit
   single-use pairing secret with a five-minute expiry and records them
   atomically. It also asks the selected relay for a temporary pairing channel
   and subscribes before displaying the invite.
2. That channel has two unrelated one-use transport capabilities: a write-only
   capability for exactly one controller-to-executor frame and a read-only
   capability for exactly one executor response. The executor retains the
   channel receive endpoint and response-write capability. Neither capability
   can access an ordinary mailbox.
3. The terminal or an already-authorized SSH session shows a QR containing the
   canonical relay origin, temporary channel ID, invite ID, the PWA's two
   channel capabilities, node HPKE public key and fingerprint, pairing secret,
   protocol version, and expiry. The channel exists only while the executor is
   online.
4. The PWA creates a non-exportable private key and a fresh CSPRNG 256-bit
   challenge before sending anything.
5. The PWA sends an HPKE Base-encrypted `pair.init` through the temporary
   channel to the pinned node key. It contains the single-use secret,
   controller public key, label, and a challenge. The consumed invite grants
   the v1 owner capability; the client cannot request or broaden its own
   authority.
6. The relay consumes the write capability after accepting the single opaque
   frame. The executor decrypts and validates it, then atomically consumes the
   inner pairing secret. An invalid frame never provisions a controller.
7. On success, the executor uses its relay-scoped node provisioning capability
   to create the controller's ordinary transport mailboxes and scoped
   capabilities, then returns an HPKE Auth-encrypted `pair.accept` through the
   retained response-write capability. The PWA consumes it through the
   read-only response capability, validates the complete pairing transcript and
   provisioned transport set, and both sides persist the peer fingerprint.
8. All existing controllers receive an encrypted `device.added` event.

The temporary pairing channel expires with the invite, permits exactly one
frame in each direction and 128 KiB total, and closes after the response is read
or the expiry is reached. Its capabilities are never reused as ordinary
controller or mailbox capabilities. The relay's lifecycle depends only on
frame counts, byte limits, online presence, response consumption, and expiry;
it never needs to inspect ciphertext. It can observe the pairing attempt and
infer successful completion from mailbox allocation and response activity, but
it does not learn either device identity, label, challenge, or encrypted
payload. Transport capabilities and the success/timing signal are disclosed
relay metadata, not hidden by the MVP. Replay, over-limit, offline-executor,
response-theft, and
expired-capability tests run before pairing is considered safe.

The complete QR is a five-minute bearer enrollment credential. Anyone who sees
it can race the intended controller and become an owner; the relay cannot
prevent that without learning enrollment semantics. The terminal keeps the
invite visible only while active, shows the controller fingerprint that won,
and every existing controller receives the encrypted `device.added` event.

A pairing secret is never placed in a query parameter, command argument, log,
or analytics event. If a deep link is used, the secret is in the URL fragment
and removed from history immediately. A short numeric code is not offered in
v1 because it would require a real PAKE and online guessing controls.

There is no cloud escrow. Loss of all controller keys requires local or SSH
re-pairing. Revocation cannot erase plaintext already seen by a controller.

### 7.3 Pairing transcript

Pairing has its own deterministic RFC 8949 CBOR transcript rather than reusing
the ordinary-envelope `info` or AAD. Values needed to open `pair.init` cannot
depend on its encrypted controller key. `PairingInviteContext`, known to both
endpoints before decryption, is therefore the exact ordered tuple:

```text
("orcode-pair-invite/v1", protocolVersion, canonicalRelayOrigin,
 temporaryChannelId, inviteId, inviteExpiry, nodeKeyFingerprint)
```

`pair.init` uses HPKE Base with `info = ("orcode-pair-init/v1",
SHA-256(PairingInviteContext))` and canonical AAD `(temporaryChannelId,
inviteId, inviteExpiry, "init")`. Its encrypted body repeats the invite context
and contains the single-use secret, controller public key/fingerprint,
controller label, and `challenge256`; the executor rejects any mismatch. After
decryption both endpoints derive the exact ordered `PairingContext`:

```text
(PairingInviteContext, controllerKeyFingerprint, challenge256)
```

`pair.accept` uses HPKE Auth with `info = ("orcode-pair-accept/v1",
SHA-256(PairingContext))` and canonical AAD `(temporaryChannelId, inviteId,
inviteExpiry, "accept")`. Its canonical encrypted body repeats the full
`PairingContext` and contains each provisioned mailbox ID, immutable policy,
quota, raw capability, and a `provisioningDigest`. That digest is SHA-256 over
the canonical IDs, policies, quotas, and SHA-256 of every capability. The PWA
recomputes it before persisting anything. AEAD authenticates the raw values;
the digest gives both endpoints one stable audit/binding value without exposing
capabilities in logs. Cross-channel, cross-relay, cross-invite, changed-key,
expired-invite, challenge-replay, and provision-substitution attempts fail.

## 8. End-to-end encryption

### 8.1 Chosen suite

The MVP uses RFC 9180 HPKE Auth with exactly:

- `DHKEM(P-256, HKDF-SHA256)`;
- `HKDF-SHA256`;
- `AES-128-GCM`;
- one fresh, single-shot HPKE context per envelope.

`@hpke/core` is pinned exactly to a reviewed patched release, initially 1.9.0.
Versions through 1.7.4 are forbidden because of the published concurrent nonce
reuse advisory. The release gate includes RFC vectors, PWA/Node interoperability,
parallel-envelope tests, dependency review, and a security-advisory scan. If the
library fails that gate, it is replaced with a reviewed RFC 9180 implementation;
Orcode does not implement HPKE primitives itself.

Initial pairing uses HPKE Base to the QR-pinned executor key. Normal traffic
uses HPKE Auth in both directions. Every envelope gets a new context and seals
exactly one canonical payload, avoiding shared nonce/counter state.

This gives content confidentiality, integrity, and sender authentication
against the relay. Scheduled key epochs bound long-term exposure, but v1 does
not claim Double-Ratchet/MLS forward secrecy or post-compromise security. MLS is
the defined future upgrade if that guarantee becomes a requirement.

### 8.2 Key storage

- PWA private keys are `extractable:false` WebCrypto `CryptoKey` objects stored
  in IndexedDB. Relay capabilities and encrypted cache keys are wrapped by a
  separate non-exportable origin key. Nothing sensitive uses `localStorage`.
- Executor identity keys use a dedicated `DeviceKeyStore`: OS keychain where a
  service-compatible keychain exists, otherwise an exact PrivateStore file with
  user-only permissions and a visible at-rest-protection status. Keys are never
  exported through the UI or logs.
- A compromised browser profile, XSS, executor account, or host root is an
  endpoint compromise and outside the relay-confidentiality guarantee.

### 8.3 PWA delivery trust

Mutable JavaScript can steal plaintext even when the relay protocol is perfect.
Therefore the managed relay runtime does not publish arbitrary PWA builds. A
separate release pipeline produces a signed, immutable PWA artifact and
manifest. Managed `app` hosting deploys that verified artifact using credentials
and a runtime isolated from the relay data plane; relay APIs use a separate
origin. Self-hosted packages contain the same pinned artifact. Service workers
cache only hashed release assets, but are not treated as a cryptographic trust
anchor.

A standard PWA trusts its HTTPS app origin and publisher on first install and on
every code update. A newly served malicious service worker could bypass checks
implemented by the old worker. Artifact signatures and hashes therefore protect
the build/deploy pipeline and detect accidental substitution; they do not make a
browser-enforced promise against a compromised app origin. A relay data-plane
compromise cannot change managed app code only while app hosting credentials,
deployment, and runtime remain actually separate. Cryptographically enforced
publisher updates would require a signed native wrapper, browser extension, or
other browser-enforced trust anchor and are outside the PWA MVP.

This continuing origin/publisher trust is stated explicitly. An installation
from a self-hosted home origin remains cloud-independent and can still connect
to managed or other self-hosted relays. Each browser origin is a separate
controller identity and must pair independently.

## 9. Envelope and delivery contract

Deterministic RFC 8949 CBOR is used for authenticated/encrypted protocol bytes.
Strict decoding rejects duplicate keys, indefinite values, unknown fields,
oversized values, invalid Unicode, and non-canonical encodings before state is
changed. Adding a field requires an explicit protocol-version schema.

Relay connections use independent random 256-bit capabilities scoped to one
mailbox operation set. A browser sends the capability in the first TLS-protected
binary WebSocket application frame, never in a URL, cookie, referrer, or
loggable subprotocol value. The relay returns no mailbox data before this frame
is validated. Capabilities control routing and quotas only; HPKE identity
controls message authenticity. They are wrapped at rest in the PWA and can be
rotated or revoked independently of device keys.

Mailbox creation is authorized separately from mailbox use. Each registered
executor receives one opaque 256-bit `nodeProvisioningCapability`, scoped to one
relay tenant and one random node namespace. Managed mode issues it only after
account-authorized node enrollment; self-hosted mode issues it through the
local/SSH bootstrap authority. It permits creation and revocation only of the
fixed executor-online, controller-store-and-forward, and temporary-pairing
mailbox classes within configured count/byte quotas. It cannot list another
namespace, read content, change an immutable delivery policy, raise quotas,
create an administrative capability, or authorize an Orcode controller. Relay
mailbox authority remains transport-only; HPKE pairing and the executor's
controller registry remain the application authorization boundary. The
provisioning capability is stored in the executor's protected device store and
can be replaced only through the same managed-account or local/SSH enrollment
authority.

Every mailbox has an immutable relay-visible delivery policy created with it:
executor mailboxes are `online-only`, while controller mailboxes are bounded
`store-and-forward`. The relay never needs to inspect encrypted message type to
apply this rule. Temporary pairing channels use their own one-frame-each-way,
online-executor contract and are not ordinary mailboxes. The delivery policy is
included in the outer envelope and AAD and is part of the disclosed metadata.

The relay-visible outer envelope contains only:

- protocol version;
- random envelope ID;
- opaque recipient mailbox and recipient key epoch;
- pairwise sender hint, random per peer and epoch;
- coarse creation/expiry times;
- direction and, for controller-to-executor traffic, a short-lived executor
  connection lease ID;
- immutable recipient mailbox delivery policy;
- fixed padding bucket;
- HPKE encapsulated key and ciphertext.

HPKE `info` binds the product protocol, suite ID, sender hint, recipient key,
and key epoch. `OuterAAD` is the canonical CBOR tuple below, in exactly this
order:

```text
(version, envelopeId, recipientMailbox, recipientKeyEpoch, senderHint,
 createdAtCoarse, expiresAt, direction, connectionLeaseIdOrNull,
 deliveryPolicy, paddingBucket)
```

It explicitly excludes HPKE encapsulated key and ciphertext; HPKE binds its
encapsulated key through the KEM context. Cross-implementation vectors tamper
with each tuple field separately. The relay therefore cannot reroute or modify
a valid envelope.

The encrypted inner payload contains:

- protocol version, message ID, session ID, direction, sequence, ack sequence,
  previous-message hash, and the same optional connection lease ID;
- sender/recipient device IDs;
- chat ID, node ID, workspace ID, workspace fingerprint, and binding epoch;
- message type and the applicable command, run, or approval ID;
- issued/expiry times and typed payload.

The relay still observes IP addresses, user agents, online times, mailbox
relationships and delivery policy, direction/lease presence, pairing-channel
creation and apparent completion, mailbox allocation, timing, padding buckets,
queue depth, retries, and rotations.
Mitigations are opaque pairwise IDs, coarse timestamps, generic pushes, no
plaintext logs, fixed size buckets, and bounded retention. IP hiding,
constant-rate cover traffic, and traffic-analysis resistance are non-goals.

## 10. Ordering, replay, and idempotency

- Sequence numbers are monotonic per sender, recipient, session, binding epoch,
  and direction.
- The receiver durably tracks the highest contiguous sequence plus a bounded
  replay bitmap and message-ID cache.
- Exact duplicates are acknowledged but never applied twice.
- A hash chain detects duplicates, forks, and interior gaps once a later
  sequence or authenticated sender checkpoint is observed. A bounded
  out-of-order window buffers valid future messages; a gap triggers an
  encrypted sync request. A dropped tail is detectable only after a later
  authenticated cursor/checkpoint, successful sync, or timeout. A malicious
  relay may suppress all later evidence indefinitely; availability is not
  guaranteed.
- Every effectful intent has a random `commandId`. The executor records
  `received` and then durably fsyncs `started` before dispatch. A retry returns
  the existing state or result and never dispatches the effect again. If the
  executor crashes after dispatch but before a final record, restart exposes
  `indeterminate`; it never retries automatically. The user must reconcile the
  external state and issue a new command ID if another attempt is wanted.
- Relay delivery is at least once. Senders journal the exact ciphertext until
  an end-to-end acknowledgement confirms durable recipient storage. Within the
  same valid connection lease, a retry resends the same ciphertext; it never
  reseals under the same envelope ID.
- A relay transport acknowledgement means only that the opaque frame crossed
  that transport boundary. `command.received` means the executor durably stored
  the command record; `command.started` means it fsynced the started state before
  dispatch; `command.final` carries the terminal result. None is inferred from
  another, and absence of an acknowledgement is always `unknown` until queried.
- Queue deletion for store-and-forward events requires recipient durable-storage
  acknowledgement, not merely WebSocket delivery.

Default outer envelope size is capped at 64 KiB; larger snapshots and outputs
are chunked. Padding buckets are 1, 4, 16, and 64 KiB. A mailbox keeps at most
50 MiB or 10,000 envelopes for 24 hours, whichever limit is reached first.
Limits may be configured downward. Generic push payloads contain only “New
Orcode activity”.

All controller-to-executor messages are live-only. On every authenticated WSS
connection the executor creates a random `connectionLeaseId`, sends it through
E2EE to online controllers, and rotates it every 20 seconds with a 30-second
absolute lifetime. The executor accepts the current and immediately previous
lease only until each lease's signed expiry, giving at most ten seconds of
bounded overlap without extending either lease. A controller that misses a
renewal stops effectful sends when its last lease expires. Every lease is
invalidated on disconnect, restart, or reconnect before a new lease is issued.
The relay never queues this direction. The executor rejects an absent, expired,
or non-current lease before applying even a previously unseen valid envelope.
This bounds delayed delivery to a current short lease; it does not promise zero
delay from a malicious relay while that lease is valid.

After lease rotation or reconnect, a controller never re-encrypts an uncertain
effect blindly. It sends a freshly encrypted `command.status(commandId)` query
under the current lease. The executor serializes the query against its durable
command journal and returns exactly `not-received`, `received`, `started`,
`final`, or `indeterminate`. Only authenticated `not-received`, observed after
the old lease is invalid, permits the original intent to be freshly encrypted
under the new lease with the same command ID. Every other state forbids
redispatch. This reconciles lost transport/received/started/final
acknowledgements without weakening at-most-once dispatch.

Executor-to-controller events may use the bounded mailbox. A run already
accepted by the executor continues locally through a phone disconnect and is
resynchronized from the executor journal.

## 11. Chat, node, and workspace binding

For every live binding the executor persists:

```text
(chatId, nodeId, workspaceId, workspaceFingerprint, bindingEpoch)
```

Every intent, approval, acknowledgement, event, and snapshot repeats that tuple
inside E2EE. The executor rejects mismatches before policy or tool execution.
The relay cannot see or change the binding.

An ordinary chat never switches target automatically. The PWA always displays
the selected relay, node, workspace, and chat above the composer.

An explicit handoff is a one-time two-phase protocol:

1. An owner asks the target for an authenticated offer naming the expected
   source node. The offer contains a random `handoffId`, source node ID and key,
   target binding tuple, nonce, target node key, and five-minute expiry.
2. An owner sends the offer to the source. The source verifies the owner,
   target, expiry, and absence of an active run/writer; it then durably records
   `handoff-pending` and freezes the old epoch read-only before sending data.
   The source serializes this transition under the chat writer lease: the first
   handoff ID wins and every concurrent offer receives a conflict.
3. The source creates a compact human-readable summary and recent-turn bundle.
   It HPKE-Auth encrypts a one-time grant directly to the target node, binding
   the handoff ID, old and new tuples, next binding epoch, current YOLO value,
   bundle hash, offer nonce, and expiry.
4. The target atomically consumes one matching offer/grant, creates the linked
   physical continuation without opaque provider SDK state or complete history,
   and returns an authenticated receipt.
5. The source records the receipt and closes the handoff. Retries use the same
   handoff ID and cannot create a second continuation.

If delivery or receipt is uncertain, the source remains visibly frozen. Recovery
queries the target by handoff ID and either completes from its receipt or obtains
an authenticated non-acceptance record after offer expiry before an owner may
abort. It never silently unfreezes or leaves two writable epochs.

The logical chat ID and its YOLO state survive an explicit handoff. A new chat
or fork receives a new chat ID and always starts in normal approval mode.

## 12. Approvals and per-chat YOLO

The executor remains the only policy authority. Terminal and PWA consume the
same `ApprovalRequest` contract and render the same exact subject, target,
details, and risk. A remote decision never contains replacement command bytes;
it can only resolve the request that the executor already created.

Each request has:

- random `approvalId` and five-minute expiry;
- run ID and exact chat/node/workspace binding;
- policy revision;
- an action digest over canonical effect, exact approval subject, host,
  workspace fingerprint, cwd, argv or diff hash, and run ID.

The response repeats the approval ID, digest, binding, and decision. Expired,
already resolved, wrong-digest, wrong-binding, or changed-policy responses are
rejected. When terminal and phone are both present, the first valid response
wins and every other surface receives the resolved state. Timeout or loss of
all approval surfaces fails closed.

YOLO is a persistent executor-owned property of exactly one logical chat:

- new and forked chats default to normal approval;
- `/yolo on` or the equivalent PWA action requires one explicit confirmation;
- it survives restart, reconnect, device change, and explicit same-chat
  handoff;
- it never expires automatically;
- only `/yolo off` or the equivalent PWA action disables it;
- `off` is immediate and does not ask for approval;
- every action that would have asked is automatically accepted and receives a
  synthetic audit record with exact action digest, policy revision, timestamp,
  and `decisionSource: yolo`;
- hard policy denial, a stored deny rule, chat/node/workspace mismatch,
  capability absence, sandbox/path containment, budgets, one-writer rules, and
  verification requirements remain enforced.

YOLO never lives in relay state and the relay cannot enable it. Every UI keeps a
persistent high-contrast YOLO indicator visible while that chat is active.

The persisted chat field is `approvalMode: read-only | ask | auto-edit | yolo`.
New and forked chats use `ask`, regardless of the old global config. The current
global `allow-all` value is not copied into a chat and never silently enables
YOLO during migration; it is migrated to the safe `ask` default with one visible
notice. Existing `read-only` and `auto-edit` behavior remains available as an
explicit per-chat choice. `/allow allow-all` remains a compatibility alias for
the explicit `/yolo on` confirmation until 1.0, but its authority is chat-scoped.

## 13. Dashboard behavior

One installed PWA dashboard contains:

- a relay switcher for managed and self-hosted connections;
- node cards showing online state and independent relay/executor/workspace-host
  roles;
- an explicit node/workspace/chat target selector;
- chat history, composer, streaming text, reasoning state, tool/process cards,
  verification, cost, limits, and run status derived from Core events;
- cancel/stop controls;
- the exact approval sheet;
- a persistent YOLO banner and explicit off control;
- device pairing, revocation, role, and connection health views.

The PWA may show an encrypted local read cache while offline. It disables
effectful controls when the executor cannot acknowledge online delivery. It
does not pretend stale status is live. A reconnect requests an event cursor or
encrypted snapshot and renders a visible gap/recovery state until caught up.

Mobile and terminal are peers as surfaces. Neither silently steals focus or
approval ownership from the other.

## 14. Managed and self-hosted deployment

### 14.1 Managed

The managed service runs the canonical OCI relay image on a conventional
container host, initially an EU Fly.io deployment with PostgreSQL. Hosting may
change without changing protocol or clients. The database stores routing,
presence, quotas, device transport capabilities, and ciphertext only.

Managed account or billing authentication is independent of E2EE identity. A
managed outage does not stop an already-running local executor; it only removes
remote reachability until reconnect.

### 14.2 Self-hosted public Linux

The supported v1 target is a public Linux x64/arm64 machine with DNS and inbound
80/443. Caddy owns automatic HTTPS and proxies the relay on loopback. The same
OCI image and PostgreSQL schema are used as managed mode.

`orcode node add ssh <alias>` performs:

1. existing OpenSSH host-key verification or explicit fingerprint confirmation;
2. read-only OS/architecture/init/port/DNS/privilege preflight;
3. explicit role selection: relay, executor, workspace-host, or a combination;
4. pinned release download and checksum/provenance verification locally;
5. SFTP/SCP transfer of the verified artifact, never `curl | sh`;
6. exact visible sudo/service-install actions;
7. separate relay and executor accounts/services;
8. external HTTPS/WebSocket reachability proof before declaring the relay live.

SSH is bootstrap, upgrade, rollback, recovery, and revocation transport only.
Normal executor traffic is outbound WSS. A machine behind CGNAT can be an
executor but cannot be the sole public relay without another public entry point.
Tailscale, Cloudflare Tunnel, and similar adapters are optional and never a
requirement or a false “fully self-hosted” claim.

## 15. Failure, recovery, and revocation

- Relay loss: local coding continues; phone status becomes offline.
- Phone loss: revoke its controller key and mailbox capability. Previously seen
  plaintext cannot be clawed back.
- All-controller loss: local/SSH pairing is the only recovery; no cloud escrow.
- Executor or phone disconnect before `command.received`: delivery is `unknown`,
  not presumed absent. After reconnect the controller uses the current lease to
  query the durable command status; only `not-received` permits a same-ID retry.
- Phone disconnect after `command.received`: the executor owns subsequent
  dispatch; encrypted events and final state resynchronize later.
- Approval timeout: normal-mode action is denied/cancelled. YOLO actions do not
  create a pending approval.
- Relay duplicate/reorder: receiver sequence and idempotency state prevents a
  duplicate effect and requests missing ranges.
- Relay deletion/censorship: endpoints detect interior gaps and tail loss once a
  later authenticated checkpoint or sync result exists, but cannot force
  delivery or distinguish an indefinitely suppressed tail from indefinite
  delay.
- Executor restart: command journal and Core/RunLog state recover
  received/started/final status before accepting duplicate IDs. A started
  command without a final record becomes `indeterminate` and is never
  auto-retried.
- Key rotation: a new receive epoch is authenticated under the existing
  relationship. Old private epochs remain only until pre-cutoff envelopes are
  acknowledged or expire, then are erased.
- Revocation: executor authorization is canonical and immediately stops future
  command processing/fan-out when an owner reaches it online or through local or
  SSH recovery. Relay capability revocation immediately blocks the lost device
  on an honest relay as defense in depth while the executor is offline. V1 does
  not claim automatic offline revocation convergence through an untrusted relay.
- Update: versioned directories, verified staging, health check, atomic switch,
  one retained previous version, and explicit rollback. No irreversible store
  migration occurs before the new service passes health checks.

## 16. Security invariants

1. Relay code cannot import executor, workspace, provider, approval, or E2EE
   private-key modules.
2. Relay storage and logs contain no decryptable content or human labels.
3. Every effect is evaluated once by executor-side central policy.
4. Every effectful message is chat/node/workspace-bound, replay-resistant, and
   idempotent before execution.
5. A controller cannot broaden an approval subject or change command bytes in an
   approval response.
6. New chats never inherit YOLO. The same logical chat does not lose YOLO through
   reconnect, restart, or explicit handoff.
7. A relay-role process has no workspace mount, executor key, provider key,
   Docker socket, or shell-execution API.
8. Remote output uses the existing ordered start/chunk/single-terminal event
   contract and central redaction/persistence boundaries.
9. Device, role, workspace, and handoff changes are authenticated owner actions;
   nodes cannot self-promote or silently rebind chats.
10. No release claims zero knowledge without disclosing continuing PWA
    origin/publisher trust, endpoint compromise, metadata leakage, lack of
    availability guarantees, and the MVP's lack of full FS/PCS.

## 17. Delivery slices

### Slice 1: Remote foundation

- Implement the missing `OrcodeCore`, `CoreIntent`, and `CoreEvent` boundary
  while keeping current CLI/TUI behavior unchanged.
- Add the single-runtime lease and authenticated local socket/pipe so local and
  remote surfaces share one Core, event stream, cancellation tree, and approval
  broker whenever remote mode is enabled.
- Add browser-safe remote protocol IDs, schemas, ordering, binding, approval,
  and idempotency contracts.
- Add HPKE Node/browser interoperability vectors and a memory-only blind relay
  test harness.
- Add the durable executor sequence/ack/command journal with
  received/started/final/indeterminate states and crash injection at every
  boundary before any real remote effect is enabled.
- Demonstrate one headless controller sending a prompt through the relay harness
  to one executor and receiving ordered events, with no relay plaintext.

This is the first implementation plan after this architecture is approved.

### Slice 2: Mobile PWA vertical path

- Release-pinned PWA shell and local key store.
- QR pairing, multi-relay dashboard, inventory, one chat, streaming status,
  cancel, approval, reconnect, and per-chat YOLO.
- Real browser E2E against the in-memory/local relay and executor.

### Slice 3: Self-hosted Linux and hybrid node

- Persistent relay store, Caddy, OCI image, systemd services, SSH bootstrap,
  role selection, update/rollback, and public reachability checks.
- Demonstrate coding in a workspace on the same host as a separately isolated
  relay process.

### Slice 4: Managed relay

- EU deployment, PostgreSQL, quotas, abuse controls, generic Web Push, health,
  metrics without content, backup/restore, and operational runbooks.
- The deployed service runs the same image and protocol as self-hosted mode.

### Slice 5: Production hardening

- Key rotation/revocation recovery, browser matrix, crash/fault injection,
  load/backpressure, protocol N/N-1, supply-chain gates, independent security
  review, and managed plus self-hosted live smokes.

## 18. Acceptance gates

### Core and protocol

- CLI, JSON, TUI, and remote harness produce compatible Core events for the same
  deterministic run.
- Event scope/IDs/sequence reject every invalid combination and preserve exactly
  one terminal event.
- Duplicate and reordered command/envelope fuzz tests never dispatch an effect
  twice. Fault injection before and after every journal boundary proves that a
  crash window returns `indeterminate` rather than retrying an external effect.
- A healthy connection remains usable for more than 30 minutes through rolling
  leases. Lost transport, received, started, and final acknowledgements at every
  boundary reconcile by status query without duplicate dispatch; a stale lease
  never authorizes a freshly encrypted effect.
- Unknown protocol and schema versions fail closed without corrupting state.

### Security and privacy

- RFC 9180 vectors and independent PWA/Node vectors pass with the exact pinned
  library version.
- Parallel encryption proves no context/nonce reuse.
- Pairing uses separate one-use send and response-read capabilities; the
  temporary channel is online-executor-only, one-frame-each-way, byte-bounded,
  and expires with the invite. The relay stays payload-blind but may observe
  attempt/completion metadata; replay and over-limit attempts fail.
- Pairing transcript vectors reject cross-channel, cross-relay, cross-invite,
  changed-key, expired-invite, challenge-replay, and provision-substitution
  attempts before controller state is persisted.
- An empty managed-style and self-hosted relay can enroll a node and provision
  only its allowed mailbox classes. Missing/wrong provisioning capabilities,
  cross-namespace creation, policy mutation, administrative-capability creation,
  and quota overflow all fail before allocation.
- Relay database, logs, metrics, crash dumps, and push payloads contain none of
  the synthetic prompts, paths, output, approval subjects, or YOLO values.
- Replay, reroute, wrong key epoch, wrong sender hint, changed AAD, expired
  pairing secret, revoked controller, and wrong binding are rejected before an
  effect.
- PWA CSP, Trusted Types, no-remote-script, asset hash, isolated app/relay deploy,
  dependency advisory, and secret-fixture gates pass. Documentation and UI state
  that the standard PWA continues to trust its app origin on updates.

### Product behavior

- One PWA connects to one managed-style and one self-hosted relay profile and
  switches without losing either local identity.
- A phone starts a real coding run on a chosen node/workspace and observes
  ordered text, process, verification, cost, and terminal state.
- Terminal and phone show one identical approval; the first valid response wins
  and the other closes as resolved.
- With remote mode active, local TUI and phone observe one Core/run sequence and
  one session writer; a second executor or in-process Core is rejected.
- YOLO turns on for one chat, auto-approves with audit records across restart and
  reconnect, remains on until explicit off, and is absent from a new/forked chat.
- A controller intent with no current executor lease is rejected, and an unseen
  envelope delivered after disconnect/restart/reconnect never executes.
- Explicit handoff advances the binding epoch, makes the source read-only,
  preserves the logical chat and YOLO state, and transfers only the compact
  handoff payload.
- Two controllers racing handoff produce one winning handoff ID and one
  conflict. Crash/timeout/receipt-loss tests leave the source visibly frozen
  until authenticated reconciliation; they never create two writable epochs.
- A hybrid Linux host proves the executor can code while the relay process has
  no workspace access. The dedicated executor account cannot read relay storage
  or credentials, and the UI does not misrepresent its logical workspace
  allowlist as containment for arbitrary approved shell commands.

### Deployment truthfulness

- Self-host bootstrap verifies SSH host identity, signed artifacts, service
  separation, TLS, and an external WebSocket probe before success.
- Managed and self-hosted smokes use the same built image digest.
- Native Windows/macOS service support, CGNAT traversal, FS/PCS, and published
  managed availability are claimed only after their own real gates exist.

### Compatibility

- Existing `orcode` and `routercode` aliases still install and run from the
  packed root npm artifact on every currently supported platform.
- Existing config, chats, rules, conversation state, run logs, checkpoints, and
  credentials remain readable through versioned, idempotent migrations.
- Ordinary startup remains local and performs no relay discovery, network
  connection, service install, or background-process activation. Remote mode is
  explicitly enabled per installation.
- Packaging gates verify that adding workspaces/packages does not accidentally
  publish source, private paths, fixtures, keys, or omit either CLI alias.
- A tested component matrix binds CLI/Core store version, remote protocol
  version, PWA build, executor build, and relay build. Current and previous
  protocol compatibility is exercised in both directions; unsupported mixes
  fail visibly before state mutation.

## 19. Primary references

- RFC 9180, Hybrid Public Key Encryption: https://www.rfc-editor.org/rfc/rfc9180.html
- RFC 8949, CBOR: https://www.rfc-editor.org/rfc/rfc8949.html
- RFC 9420, Messaging Layer Security for the future FS/PCS upgrade:
  https://www.rfc-editor.org/rfc/rfc9420.html
- Noise Protocol Framework, considered but not selected for the MVP:
  https://noiseprotocol.org/noise.html
- Web Crypto API and non-exportable `CryptoKey` handling:
  https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
- hpke-js implementation and security notes: https://github.com/dajiaji/hpke-js
- hpke-js nonce-reuse advisory:
  https://github.com/dajiaji/hpke-js/security/advisories/GHSA-73g8-5h73-26h4
- OpenSSH host identity behavior: https://man.openbsd.org/ssh
- Caddy automatic HTTPS: https://caddyserver.com/docs/automatic-https
