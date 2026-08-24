# Orcode Kimi Code Membership Provider Design

Date: 2026-08-24  
Status: Approved by user on 2026-08-24
Depends on: `2026-08-23-orcode-startup-provider-setup-design.md` and final
approval of the provider-authority stabilization

## 1. Goal

Add Kimi Code as a real, independently selectable Orcode provider whose usage
is charged against the user's Kimi Code membership benefits. The provider must
reuse Orcode's exact credential, account, route, activation, recovery, startup,
and Cross boundaries. It must not copy or impersonate the official Kimi
client's OAuth identity.

The first release supports the official third-party integration contract:

- a user-created Kimi Code membership API key;
- the official OpenAI-compatible endpoint
  `https://api.kimi.com/coding/v1`;
- the documented Kimi Code model IDs;
- personal, local, interactive Orcode use only.

Kimi Open Platform pay-as-you-go and native Kimi OAuth are separate future
integrations. Neither is silently substituted for Kimi Code membership.

### 1.1 Global single-owner boundary

The user requires every Orcode provider and model—not only Kimi—to be
single-owner. A subscription, API key, account route, provider session, or
runtime proof belongs exclusively to the local Orcode owner. It may never be
used by another person, tenant, team member, anonymous client, public endpoint,
shared daemon, or resale service.

Provider credentials remain inside the private store of the owner's operating
system account. Local sockets and process APIs are owner-only. A future remote
feature may permit the same owner to use an explicitly enrolled personal
device, but only with strong owner authentication and device revocation. A
relay, remote host, browser client, or transport service never receives or
becomes the owner of provider credentials. Multi-user use requires a separate
design and separate provider credentials; it cannot be enabled by configuration
alone.

This global owner-only rule does not by itself prohibit owner-initiated
non-interactive use of providers whose terms allow it. Kimi Code has the
additional provider-specific personal-interactive restriction in section 3.

## 2. User outcome

The setup hub presents:

```text
OpenRouter             Stable · API-Guthaben · viele Modelle
Kimi Code Abo          Stable · Membership-Key · Coding-Modelle
Anthropic / Claude-Abo Coming soon
```

Selecting `Kimi Code Abo` explains that Orcode is a third-party tool and asks
for a Kimi Code Console API key. It does not ask for a Kimi password, browser
cookie, device code, or token owned by the official Kimi CLI.

After validation, the user chooses among the currently documented and
available Kimi Code models. One Kimi provider and one model are sufficient for
ordinary chat. OpenRouter is not required. Adding Kimi never enables Cross;
the user may later use Kimi and OpenRouter together through the existing
explicit Cross preparation flow.

## 3. Official integration boundary

Kimi documents two different authentication paths:

1. OAuth device-code login for official Kimi Code clients such as the Kimi CLI
   and VS Code extension.
2. A manually created Kimi Code API key for third-party tools and self-built
   applications.

Orcode implements only path 2. It must not:

- reuse the Kimi CLI credential store;
- invoke `kimi login` and parse its files;
- copy an official client ID, token, cookie, device code, or User-Agent;
- fall back to a Kimi Open Platform key or base URL;
- claim that native Kimi OAuth is available.

The setup explanation may show `Mit Kimi anmelden · Coming soon`, but that row
has no adapter and produces no credential, browser, child-process, filesystem,
or network effect.

Every request sends Orcode's truthful product/version identity. Kimi Code
membership is for personal interactive use. The provider is unavailable to
scheduled jobs, unattended batch execution, multi-user relay service, resale,
or SaaS proxying. A future enterprise/Open Platform design is required for
those modes.

## 4. Provider identity and billing

The backend ID is `kimi-code`. It is distinct from `openrouter`, `codex`,
`anthropic`, and any future `kimi-platform` backend.

The billing realm is:

```text
kimi-code-membership-provider-managed-overage
```

This conservative label is used because membership quota and rolling limits
are provider-managed, while a user may separately enable paid Extra Usage.
Orcode never promises that a request is free, never displays an unknown quota
as zero, and never infers remaining quota from HTTP success.

The current third-party membership API does not document a stable account ID.
Until Kimi publishes one, Orcode derives the route's safe account fingerprint
as a local keyed HMAC over a domain-separated normalized membership key:

```text
HMAC(localIdentityKey, "orcode-kimi-code-credential/v1\0" + normalizedKey)
```

The raw key never leaves the callback that owns it and never enters provider
state, config, logs, events, reports, or test snapshots. Replacing the key is
therefore conservatively treated as an account/billing-route change, even when
both keys belong to the same Kimi account. The user must explicitly confirm
the transition. This is less convenient than a stable provider account ID but
fails closed against cross-account billing.

## 5. Credential ownership

Kimi Code credentials use a strict pointer:

```text
v1:kimi-code:<canonical UUID>
```

The secret is stored only in Orcode's private credential store. Provider state
stores the pointer and the safe account fingerprint. The parser accepts no
legacy, OpenRouter, Kimi Platform, path-like, case-aliased, malformed, or future
pointer as a Kimi Code credential.

The first release does not automatically read a Kimi environment variable.
There is one unambiguous source: the saved membership key. Process-only Kimi
credentials may be designed later, but may never override or fall back around
a saved or retiring credential.

Credential reads and provider metadata calls run through the same
connection-bound `ProviderCredentialAuthority` as OpenRouter:

- exact `connectionId`, backend, pointer, account fingerprint, billing realm,
  state revision, generation, purpose, signal, and absolute deadline;
- pending forget or recovery blocks prompts and network;
- disabled connections perform zero startup credential reads and zero network;
- late values after abort/deadline cannot create proof, route, state, UI, or
  runtime effects;
- runtime publication revalidates the exact credential and binding under the
  provider authority before activating it.

## 6. Models and catalog

The initial reviewed allowlist is:

| Canonical model ID | Display | Availability and local declaration |
| --- | --- | --- |
| `k3` | Kimi K3 | Moderato or above; up to 1M context where the plan allows it; thinking `low/high/max` |
| `k3-256k` | Kimi K3 256K | Moderato or above; 256K context; thinking `low/high/max` |
| `kimi-for-coding` | Kimi K2.7 Code | All Kimi Code members; 256K context |
| `kimi-for-coding-highspeed` | Kimi K2.7 Code HighSpeed | Allegretto or above; higher quota consumption |

Orcode requests the provider's model catalog using the official
OpenAI-compatible membership endpoint and intersects it with this reviewed
allowlist. Unknown model IDs are ignored, not auto-enabled. Missing allowlisted
models are not shown. A catalog outage leaves the credential retained and the
provider offline/unknown; it never causes a billable model request merely to
test setup.

Model capability declarations are local reviewed data. Orcode must not promise
image, video, tool, context, or thinking support that its own runtime does not
actually implement. A later documentation-only model refresh may update the
allowlist after official verification and tests.

## 7. Health and safe errors

Startup inspects only enabled Kimi Code connections. It uses metadata/catalog
operations, never a chat completion. The normal per-provider 5-second deadline,
15-second configured maximum, 8-second whole-startup default, and 30-second
whole-startup maximum remain binding.

Minimum safe classifications:

- HTTP 401: `kimi-code-auth-rejected`;
- HTTP 402: `kimi-code-membership-unavailable`;
- HTTP 403 access termination: `kimi-code-access-terminated`;
- HTTP 429: `kimi-code-limit-reached`, retryable after provider window reset;
- timeout/offline/TLS/5xx: retryable offline/unknown;
- unknown or malformed provider data: fail closed.

No provider response body, header value, request ID, key fragment, account
identifier, email, URL containing credentials, local path, or dependency error
message reaches UI, events, logs, JSON output, reports, or thrown public errors.
User-facing messages are fixed Orcode copy.

## 8. Activation, recovery, and logout

Kimi activation uses the existing provider-wide runtime-to-provider lock order
and crash-recovery journal. The transaction is:

1. normalize the key inside the secret boundary;
2. acquire exact candidate authority and inspect metadata/catalog within one
   absolute deadline;
3. derive the safe key fingerprint and exact candidate route;
4. reject duplicate backend/account/billing identity under ownership;
5. reserve a new Kimi credential slot;
6. write and read back the key;
7. publish config pointer and provider state under exact CAS/fences;
8. bind the runtime only with the exact inspected credential proof;
9. complete the journal and retire the old unreferenced slot.

Every crash point recovers to the complete old or new tuple. No state may say
Kimi is enabled/default while the live runtime has no matching proof. A late
failure after exact durable adoption is classified from exact readback, not
reported as a false cancellation.

`/provider disable kimi-code` retains the credential but makes the next startup
perform zero Kimi credential/network calls. Explicit enable may read the exact
retained slot under authority. `/provider logout kimi-code` requires an exact
confirmation token, revalidates it inside the durable commit, clears every
route that references that exact connection, and deletes only an unshared exact
Kimi slot through the restart-safe forget journal.

## 9. Commands and setup presentation

These commands use the shared typed provider intent port:

```text
/provider connect kimi-code
/provider enable kimi-code
/provider disable kimi-code
/provider reconnect kimi-code
/provider status
/provider models kimi-code
/provider logout kimi-code
```

`/provider status` displays only safe state:

```text
Kimi Code · bereit
Abo · providerverwaltete Limits; Extra Usage kann kostenpflichtig sein
Modell · Kimi K2.7 Code
Kontingent · im Kimi Code Konto prüfen
```

It never displays the key, a prefix/suffix, a raw account ID, an email address,
or fabricated quota. Setup cancellation preserves chat, persists the normal
cancelled lifecycle once, and leaves Cross off.

## 10. Runtime and Cross rules

The Kimi adapter implements the existing connection-bound backend contract. A
global singleton may be shared only if every operation carries the exact
connection ID and retrieves authority per request; it may not cache a key,
credential pointer, account, or environment fallback in its constructor.

A Kimi route identity is the exact tuple:

```text
kimi-code + accountFingerprint +
kimi-code-membership-provider-managed-overage + canonicalModelId
```

It never equals an OpenRouter route with the same model display name. Cross may
prepare a Kimi route and an OpenRouter route, or two distinct canonical models
where current Cross rules allow it, but remains off until the user explicitly
starts it. Adding, enabling, reconnecting, replacing, or logging out of Kimi
never starts Cross.

Kimi Code membership execution is allowed only for a local, user-initiated
interactive Orcode session. Background tasks, scheduled execution, remote
multi-user relay, unattended `--json`/batch loops, and service resale reject
before credential read or provider network.

## 11. Migration and compatibility

Existing installations gain no Kimi connection during migration. Migration:

- does not inspect Kimi executables or Kimi CLI state;
- does not read Kimi environment variables, config, OAuth files, or keychain;
- does not contact `kimi.com`, `api.kimi.com`, Moonshot, or OpenRouter;
- does not change existing OpenRouter routes, sessions, Cross preferences, or
  Anthropic Coming-soon state;
- is byte-idempotent on the second run.

Adding the new backend and billing realm requires a reviewed nested provider
state schema migration. Future/unknown versions continue to fail closed and
cannot be overwritten by unrelated config saves.

## 12. Test and release gates

The implementation is test-first and must prove at least:

1. Kimi setup card, fixed copy, keyboard/mouse/plain/TUI parity.
2. Membership key normalization, private slot storage, exact readback, and no
   raw secret in config/events/logs/reports/PTY transcripts.
3. Kimi membership and Kimi Open Platform keys/base URLs are never tried across
   systems.
4. Disabled/migrated/Coming-soon states perform zero credential, process, and
   network effects.
5. 401/402/403/429/5xx/offline/timeout/catalog corruption map to fixed safe
   outcomes with exact retryability and no provider-body leakage.
6. All four allowlisted model IDs are gated by the returned catalog and retain
   exact canonical route identity.
7. Saved-key replacement, crash recovery, pending forget, shared-slot refusal,
   same-revision account replacement, stale generation, abort at every awaited
   boundary, and cross-process ownership loss leave one complete tuple.
8. A mutable key or binding cannot change between inspection and runtime bind.
9. `/provider` command confirmation, status, model, reconnect, disable, enable,
   and logout operate on the exact selected Kimi connection in either order
   relative to other providers.
10. Historical sessions retain exact Kimi route identity and cannot silently run
    through OpenRouter or a different Kimi account.
11. Kimi use is rejected before credential/network in scheduled, relay,
    multi-user, and unattended batch modes.
12. Every provider credential and runtime route is owner-only: foreign local
    users, anonymous/local-network clients, unenrolled remote devices, shared
    services, and multi-tenant callers are rejected before credential read or
    provider network. An explicitly enrolled personal device still cannot
    receive the provider credential itself.
13. Cross remains off after every setup, migration, repair, restart, command,
    model change, and recovery path.
14. POSIX PTY and Windows-gated contracts cover paste/cancel/setup copy without
    retaining secret bytes or leaking error diagnostics.
15. Existing OpenRouter, Anthropic Coming-soon, CLI, migration, session, config,
    and release suites remain green.

The frozen final tree must pass focused provider/Kimi tests, both TypeScript
projects, generated docs, privacy scan, build, package contents, release
metadata, and one captured repository-full test run before integration.

## 13. Explicit non-goals

- Native Kimi OAuth or browser/device-code login in Orcode.
- Reading or managing the official Kimi CLI/VS Code credential store.
- Kimi Open Platform pay-as-you-go.
- Enterprise, resale, multi-user, remote relay, or unattended automation use.
- Sharing any Orcode-owned provider credential or runtime proof with another
  user; future same-owner device access remains credentialless at the client.
- Automatic environment-key fallback.
- Dynamic trust of undocumented model IDs, capabilities, account identifiers,
  billing claims, or quota values.
- Enabling Cross automatically.

## 14. Official references

- Kimi Code overview and third-party API contract:
  https://www.kimi.com/code/docs/en/
- Kimi Code membership and quota behavior:
  https://www.kimi.com/code/docs/en/kimi-code/membership.html
- Kimi Code model IDs and capabilities:
  https://www.kimi.com/code/docs/en/kimi-code/models.html
- Kimi Code community and interactive-use rules:
  https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html
- Kimi Code error classifications:
  https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
- Official client OAuth versus third-party API-key setup:
  https://www.kimi.com/en/help/kimi-code/membership-guide
