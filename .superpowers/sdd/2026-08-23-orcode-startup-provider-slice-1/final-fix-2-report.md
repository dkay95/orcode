# Final Whole-Branch Fix 2 Report — Exact Setup, Session, and Legacy Logout Binding

## Base and scope

- Exact base: `8d17a0c11f12efc5e8d3a9534e94ec2df113fc6d`.
- Work stayed on `codex/orcode-provider-fix2` in its isolated worktree.
- Scope is only Final Fix 2: setup cancellation, exact current/historical
  session-route binding, and Legacy logout authorization/readback ordering.
- Kimi, TUI/raw-secret lifecycle, and the Fix 1 authority implementation were
  not changed. The approved Spec and Plan remain byte-unchanged.
- No global `npm test` or `npm run check` was run.

## Formal tests-only RED — production unchanged

Before the first production edit, `git diff --name-only -- src` was empty.
Three focused commands reached exactly 18 tests: 1 passed and 17 failed for the
expected missing behavior, with no harness or compile failure.

### Setup cancellation — 7 reached, 1 passed, 6 failed

1. `hub cancellation publishes exactly one generation-aware cancelled lifecycle`
2. `secret cancellation publishes exactly one cancelled lifecycle and stops setup`
3. `model cancellation publishes exactly one cancelled lifecycle and emits no later setup action`
4. `persistence cancellation publishes exactly one cancelled lifecycle and emits no later setup action`
5. `caller abort cancellation preserves the exact reason object and performs no later setup action`
6. `stale setup cancellation cannot overwrite a newer committed activation`
7. `Cross Escape after committed ready is Later and never cancels setup` — the
   required unchanged positive control passed.

### Session route and Legacy logout — 10 reached, 0 passed, 10 failed

1. `dashboard proves a foreign historical route before current chat, config, or agent mutation`
2. `runCli synchronizes the exact startup route into the current session before agent creation`
3. `credential activation and key replacement synchronize the current session to the exact returned route`
4. `reconnect synchronizes the current session to the exact rebound route`
5. `legacy logout rechecks the retained confirmation inside authoritative commit for same-revision replacements`
   - `fingerprint`
   - `credential slot`
   - `default route`
   - `backend and billing realm`
6. `disabled legacy logout forgets runtime only after exact durable commit readback`

### Command chat opening — 1 reached, 0 passed, 1 failed

1. `chat open proves a foreign exact route before config, session, agent, or current-file mutation`

The RED failures were exact: production called cancellation zero times, stale
cancellation overwrote a newer configured state, session preferences retained
the old/no route, foreign chats transitioned on the current account, and
Legacy logout mutated/released runtime from a stale confirmation or skipped the
durable boundary for an already-disabled binding.

## Production correction

### One setup cancellation authority

- Every pre-activation exit in the production hub now calls one memoized
  `SetupOrchestrator.cancelSetup()` request with the exact caller reason,
  prompt phase, initial durable revision, and whole-startup generation.
- Cancellation captures authority before any activation wait. Revision,
  generation, and exact-state checks prevent an older cancellation from
  overwriting a newer inspection or activation.
- The cancelled lifecycle and one setup-required event publish only after the
  exact CAS/readback. No later prompt, catalog, or activation action follows.
- Cross Escape/`Later` after a successful activation stays `ready` and never
  enters cancellation.

### Exact current and historical session routes

- Startup, explicit setup, credential activation/key replacement, retained
  enable, and reconnect synchronize the exact resolved
  backend/model/account-fingerprint/billing-realm route into the current
  `SessionStore` before agent creation or later model use.
- Historical resolved routes use an exact connection selector, reconnect proof,
  exact model catalog match, and exact runtime bind. Missing, ambiguous,
  foreign-unproved, or stale bindings raise setup-required before active chat,
  config, agent, or current transcript mutation.
- Dashboard and `/chat open|switch` prove/select first, then save the previous
  chat with its previous exact route, transfer session ownership, and persist
  the selected exact route. A failed foreign proof leaves all caller-owned
  state and bytes unchanged.
- A failed startup proof for a foreign current session is fenced from falling
  back to an otherwise runnable default account.

### Legacy logout exact confirmation/readback

- The consumed confirmation binding is retained through the provider lease and
  compared again inside `ProviderStateStore.commit` against the authoritative
  durable state.
- Same-revision changes to connection identity, enabled state, credential slot,
  fingerprint, billing realm/backend, default route, session route, or process
  generation return a fresh confirmation token with zero state/runtime effect.
- Enabled and already-disabled durable Legacy bindings both cross one exact
  commit/adopt/readback boundary. `OpenRouterService.forgetKey()` runs only
  after that boundary has returned successfully.

## Adversarial follow-up

Self-review added two further production-path REDs:

- `failed startup proof for a foreign current session cannot fall back to the runnable default account`
- `caller abort settles a pending hub prompt with the exact reason and one cancellation`

It failed by returning the current default route after foreign catalog proof
failed, then passed after the current session's resolved route became an
explicit fail-closed run gate. A positive companion verifies the exact order
`foreign reconnect -> route proof -> foreign catalog -> foreign runtime bind`
before adopting the historical session. The pending-prompt case initially hung
behind the unresolved UI promise, then passed after setup input became
abort-aware and routed the exact signal reason through the single cancellation
authority without allowing any later setup action.

## Focused verification

- Formal Fix 2 GREEN matrix: 18/18 passed.
- `tests/setup-ui.test.ts`: 30/30 passed.
- `tests/setup.test.ts`: 59/59 passed.
- `tests/cli.test.ts`: 114/114 passed in the final combined run.
- `tests/commands.test.ts`: 50/50 passed.
- `tests/session.test.ts`: 43/43 passed.
- Focused combined CLI/commands/setup/session/integration run: 326/326 passed,
  including 30/30 integration tests.
- `tests/provider-privacy.test.ts`: 3/3 passed after supplying the isolated
  worktree with a temporary dependency symlink required by its fresh-build
  harness; the symlink and failed-build temp directories were removed.
- `npx tsc -p tsconfig.json --noEmit`: PASS.
- `npx tsc -p tsconfig.tests.json --noEmit`: PASS.
- Command documentation check: PASS.
- Approved Spec/Plan diff: empty.
- `git diff --check`: PASS.

## Files

Production:

- `src/setup.ts`
- `src/setup-ui.ts`
- `src/cli.ts`
- `src/commands.ts`

Tests:

- `tests/setup-ui.test.ts`
- `tests/cli.test.ts`
- `tests/commands.test.ts`

Evidence:

- `.superpowers/sdd/2026-08-23-orcode-startup-provider-slice-1/final-fix-2-report.md`

Exact commit subject: `fix: bind provider setup and sessions exactly`.

## Review round 1 — exact chat handoff

### Base and formal RED

- Exact follow-up base: `a7407feb7d73938acf243b7d9c45c1223f6d0697`.
- Before production changed, `git diff --name-only a7407feb7d73938acf243b7d9c45c1223f6d0697 -- src`
  was empty.
- One name-filtered `tests/cli.test.ts` run reached exactly 3 tests: 0 passed,
  3 failed, with no compile or harness failure:
  1. `late agent creation after /chat open uses selected exact session` —
     `createAgent.session.id` was startup chat A instead of selected chat B.
  2. `failed post-bind previous-session save cannot leave a runnable foreign binding` —
     one foreign-model callback ran after the old-chat save rejected.
  3. `reconnect repairs persisted foreign route when runtime projection is empty` —
     only reconnect B ran; exact proof, B catalog, and B runtime bind were absent.

### Central correction

- `runCli` now owns one mutable current session. Command and dashboard chat
  switches call one handoff which commits provider/session/agent/local-runtime
  ownership together; late agent creation and prompt preferences consume that
  owner instead of the startup closure.
- Foreign historical selection proves the exact route and catalog under the
  runtime lease, physically binds it, then leaves it pending. No model action
  can use a pending route. Only `adoptSession()` for the exact selected chat
  publishes it; a failed previous-chat save therefore leaves the process
  setup-required with zero foreign model bytes.
- Pending publication is generation checked and is superseded by later
  credential activation/forget. A resolved session/runtime mismatch is an
  explicit setup-required gate.
- Reconnect uses one desired-route order: current runtime projection, then the
  persisted current-session route, then the durable default. A persisted
  foreign route must pass exact connection proof and an exact one-model catalog
  match before bind/adoption; it never falls back to the default account.

The first post-production run reached the three intended paths (2/3 passed)
and exposed only a test-fixture identity mistake: `SessionStore.openById()`
returns the selected B instance rather than mutating the earlier construction
handle. The assertion was tightened to record the actual prompt-owning session
ID; it still proves `createAgent.session.id === B`, A is unchanged, and the
first prompt belongs only to B.

### Review-round verification

- Named review matrix: 3/3 passed.
- `tests/cli.test.ts`: 117/117 passed.
- `tests/commands.test.ts`: 50/50 passed.
- Focused combined setup/setup-UI/CLI/commands/session/integration run:
  329/329 passed, including 30/30 integration tests.
- `tests/provider-privacy.test.ts`: 3/3 passed with the temporary isolated
  worktree dependency symlink removed afterward.
- `tsc -p tsconfig.json --noEmit`: PASS.
- `tsc -p tsconfig.tests.json --noEmit`: PASS.
- `node --import tsx scripts/render-command-docs.ts --check`: PASS.
- Approved setup Spec/Plan diff from the follow-up base: empty.
- `git diff --check`: PASS.

Exact follow-up commit subject: `fix: bind chat handoff to exact session`.

## Review round 2 — Cross publication and Legacy logout completion

### Base and formal tests-only RED

- Exact follow-up base: `edba1d8498838222e01195bdfb1f40959fa0f7e2`.
- Before the first production edit, the complete `src` tree hash was
  `46ccb9df0522e690f531fa0d4ce767d3e5a107177440d00dc476023ba623da14`;
  `git diff --name-only -- src` was empty. After adding only tests, the same
  hash was reproduced byte-for-byte.
- The name-filtered formal matrix reached exactly 3 tests: 0 passed and 3
  failed, with no TypeScript or harness failure:
  1. `late Cross completion after newer activation cannot republish the old route or session owner`
     published the superseded A route/session after durable and runtime B had
     already become authoritative.
  2. `caller abort during post-activation Cross settles as Later with no late effects`
     stayed pending behind an unresolved Cross prompt.
  3. `legacy logout completes or recovers the exact disabled tuple after first post-commit lease loss`
     propagated the fixed first post-commit lease loss after the exact disabled
     state had already committed and adopted.

### Central correction

- Post-activation Cross now carries the caller signal and an exact setup/runtime
  generation fence. Both Cross prompts use the abort-aware setup-input boundary;
  stale or aborted completion is `Later` and publishes no notice, roles, route,
  session owner, or runtime projection.
- A persisted Cross role commit compares against the exact activation state and
  captured revision. Immediately before route/session adoption, `runSetup`
  rechecks the same setup generation, process-route generation, and exact
  persisted default route. A newer activation therefore remains the sole owner.
- Legacy logout records a module-private exact committed outcome only after the
  durable commit/adopt/readback returns. If the retained lease is then lost, it
  reacquires the canonical activation authority, verifies the exact committed
  disabled state, and completes State/Config/Runtime/session cleanup exactly
  once. A trailing lease error after completion returns the committed result
  instead of exposing a half tuple.

### Review-round verification

- Named review matrix: 3/3 passed.
- `tests/setup-ui.test.ts`: 31/31 passed.
- Prior Fix2 authority/session regression matrix: 14/14 passed, including the
  three exact chat-handoff cases, foreign route proof, reconnect ordering,
  credential/session synchronization, and Legacy logout replacement cases.
- Serial combined setup/setup-UI/CLI/commands/session/integration focus:
  332/332 passed.
- `tests/provider-privacy.test.ts`: 3/3 passed after supplying the isolated
  fresh-build harness with a temporary dependency symlink; it was removed
  immediately after the run.
- `npx tsc -p tsconfig.json --noEmit`: PASS.
- `npx tsc -p tsconfig.tests.json --noEmit`: PASS.
- `node --import tsx scripts/render-command-docs.ts --check`: PASS.
- Approved setup Spec/Plan diff from `8d17a0c11f12efc5e8d3a9534e94ec2df113fc6d`:
  empty.
- `git diff --check`: PASS.
- No global/full test or `npm run check` was run.

Exact follow-up commit subject: `fix: fence provider Cross and logout completion`.

## Review round 3 — effect-time Cross role publication

### Base and formal tests-only RED

- Exact follow-up base: `ca82b09ad0c89ecff19a8a8eb921242a227da143`.
- Before production changed, `HEAD:src` had tree hash
  `80a60a454116565c7596f5010f7e1d7c268d8613`. After adding only the two
  required tests, the same tree hash and an empty `git diff --name-only -- src`
  proved that production remained byte-unchanged.
- The name-filtered formal matrix reached exactly 2 tests: 0 passed and 2
  failed, with no TypeScript or harness failure:
  1. `caller abort after Cross role commit entry leaves no prepublication effects`
     advanced the durable revision from 1 to 2 and stored stale Cross roles.
  2. `superseded Cross role commit entry leaves no prepublication effects`
     advanced the durable revision from 1 to 2 and stored stale Cross roles.
- A focused store test additionally failed 0/1 before the terminal publication
  capability existed. After the central CAS correction but before the outer
  runtime fence, the focused runtime test failed 0/1 because the aborted setup
  still published the activated route into its session.

### Central correction

- The Cross role commit now carries one effect-time assertion combining the
  caller signal, exact setup and process-route generations, startup authority,
  and the byte-exact captured activation state. The durable writer executes
  that assertion as the final statement under the config lock after its final
  ownership and exact-snapshot checks, immediately before atomic publication.
- `ProviderStateStore` exposes one terminal `adoptPublished` capability. The
  persistence owner may use it only for the exact candidate it built and
  verified durable. A later abort or generation change therefore reconciles
  the committed revision instead of falsely rolling it back; unpublished
  adoption retains the existing fallible fence and rollback behavior.
- `DefaultProviderRuntime.runSetup` applies the same signal/deadline,
  setup-generation, process-route-generation, and startup-authority fence to
  the whole route/session/prepared-role publication block. A stale setup cannot
  adopt a route, change `mainModel`, or clear newer prepared roles. The final
  authoritative provider-state synchronization remains unconditional so an
  already committed rename is reflected exactly.
- Boundary tests cover abort and supersession on both sides of durable
  publication. Before publication, revision and Cross roles remain unchanged
  and no notice, session, runtime, or prepared-role effect appears. After
  publication, the exact revision and roles are adopted without any late UI or
  route publication.

### Review-round verification

- Required formal RED: 0/2 passed before production changed; the same named
  matrix is now 2/2 passed.
- Cross prepublication plus postpublication boundary matrix: 4/4 passed.
- Provider-state committed-publication reconciliation: 1/1 passed.
- Runtime prepublication abort publication fence: 1/1 passed.
- Real config-writer publication ordering and exact-byte preservation: 1/1
  passed.
- `tests/setup-ui.test.ts`: 35/35 passed.
- `tests/provider-state.test.ts`: 24/24 passed.
- Prior six Fix2 authority/session/Cross/Legacy regressions: 6/6 passed.
- Serial `tests/cli.test.ts` plus `tests/commands.test.ts`: 170/170 passed.
- `tests/provider-privacy.test.ts`: 3/3 passed after supplying the isolated
  fresh-build harness with a temporary dependency symlink; the symlink was
  removed immediately after the run.
- `npx tsc -p tsconfig.json --noEmit`: PASS.
- `npx tsc -p tsconfig.tests.json --noEmit`: PASS.
- `node --import tsx scripts/render-command-docs.ts --check`: PASS.
- Approved setup Spec/Plan diff from
  `8d17a0c11f12efc5e8d3a9534e94ec2df113fc6d`: empty.
- `git diff --check`: PASS.
- No global/full test or `npm run check` was run.

### Files

Production:

- `src/cli.ts`
- `src/provider-state.ts`
- `src/setup-ui.ts`

Tests:

- `tests/cli.test.ts`
- `tests/provider-state.test.ts`
- `tests/setup-ui.test.ts`

Evidence:

- `.superpowers/sdd/2026-08-23-orcode-startup-provider-slice-1/final-fix-2-report.md`

Exact follow-up commit subject: `fix: fence Cross role publication`.
