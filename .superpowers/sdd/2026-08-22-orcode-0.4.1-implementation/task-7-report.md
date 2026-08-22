# Task 7 report

## Status

DONE

## Evidence

### RED

- Required focused command before production edits:
  `node --import tsx --test tests/compressor.test.ts tests/conversation.test.ts tests/agent.test.ts tests/resume.test.ts`
- Initial exit: 1; 94 tests reached, 85 passed and 9 failed.
- Every captured-request matrix case failed under the old ownership model:
  first/no state, valid SDK state, forced compression, below-threshold
  compression, compressor failure, main failure and cancellation. The current
  request occurred twice (`2 !== 1`) and the same-call compressed seed was
  absent (`0 !== 1`). `reset(seed)` also failed because the seed was ignored.
- Reviewer-hardening tests were added RED before their fixes:
  - exact summary/history coverage rejected permissive equal-turn reuse;
  - a synchronous cost-free main failure changed the session revision;
  - a cost-free session-commit failure changed revision/`updatedAt`;
  - a synchronous post-usage throw did not persist its incurred main cost;
  - the valid migration fixture without the new digest was correctly isolated.

### GREEN

- Required focused command: 105/105 passed, 0 failed.
- Production TypeScript: `npx tsc -p tsconfig.json --noEmit` passed.
- Test TypeScript: `npx tsc -p tsconfig.tests.json --noEmit` passed.
- Related OpenRouter/session/storage/migration/integration/commands/resume
  regressions: 138/138 passed, 0 failed.
- Full regression: `npm test` reached 735 tests; 734 passed, 0 failed and 1
  platform-only skip.
- Central credential-fixture scanner and the literal audit for
  `sk-or-`, `AKIA`, `glpat-` and `npm_` returned no findings.
- `git diff --check` passed.

## Implementation

- Added one explicit per-request history-source decision: reuse SDK state only
  when it covers the exact current redacted transcript/summary epoch, otherwise
  stage exactly one fresh raw or compressed handoff.
- Removed current-prompt ownership from the compressor. The current user
  request and its attachments exist only in the main request; compressor input,
  fresh handoff and staged seed contain prior history only.
- Made `ConversationStore.reset(seed)` real. A fresh SDK state is staged before
  `callModel`, so the same call's `state.load()` sees the handoff. `discard()`
  restores the old committed view, while reset without a seed and explicit
  invalidation make stale coverage unusable.
- Bound reusable SDK state to both exact turn count and a SHA-256 digest of the
  redacted summary and transcript, including role, content and turn timestamp.
  State commits derive that digest from the committed chat artifact, and
  conflict adoption requires the same exact coverage.
- Kept volatile project notes and run limits as one-call developer messages.
  The state accessor removes those exact transient messages before buffering an
  SDK save, so they are neither duplicated on the request nor persisted.
- Made session/state commit ordering transactional: staged turns, summary,
  tool-call summaries and SDK state commit only after a successful main
  response and successful session save. Failure, abort or save failure discards
  staged conversation state and restores prior session data.
- Preserved real provider charges independently of chat success. Compressor and
  main costs are booked once after usage, including post-usage throw/abort;
  cost-free failures leave the session artifact byte-identical.
- On concurrent session merge, failed conversation commit or invalid state,
  SDK coverage is invalidated so a retry/reopen uses complete history instead
  of replaying stale state.
- Added `historyDigest` only to the approved
  `StoredConversationStateFile` schema/parser in `src/storage.ts`. A state file
  without it is safely unusable. The valid migration fixture now carries the
  field; the dedicated legacy-without-digest fallback test remains.

## Captured-request and transaction coverage

- Main request and `state.load()` are recursively inspected with unique
  sentinels, proving one current-prompt occurrence and one history source.
- Forced compression uses a real attachment fixture and proves that neither the
  prompt nor attachment name enters compressor input, handoff or seed.
- Success, main stream failure, synchronous main failure, compressor failure,
  cancellation, state commit failure and session commit failure assert the
  intended in-memory and on-disk mutations, including same-call seed visibility
  and exact cost deltas.
- Conversation tests cover seed/reset, transient stripping, exact digest epoch,
  missing-digest fallback, commit failure and reopen fallback. The existing
  resume suite remains unchanged because the production resume path needed no
  behavior edit; it is included in both the required focus and related
  regression gates.

## Scope

- Planned production files changed: `src/agent.ts`, `src/compressor.ts`,
  `src/conversation.ts`, `src/session.ts`.
- Approved narrow schema dependency: `src/storage.ts` only for
  `StoredConversationStateFile.historyDigest` and parsing.
- Planned tests changed: `tests/agent.test.ts`, `tests/compressor.test.ts`,
  `tests/conversation.test.ts`.
- Approved migration fixture update: `tests/app-home-migration.test.ts`.
- No further storage semantics, resume behavior, provider routing or unrelated
  feature work was added.

## Self-review

- Confirmed valid SDK state sends only the current user item plus volatile
  developer data; transcript history is absent from main input.
- Confirmed fresh raw/compressed state sends the handoff exactly once through
  state and never repeats it in main input.
- Confirmed staged conversation state never becomes committed coverage before
  the corresponding chat turns are durably saved.
- Confirmed summary changes invalidate equal-turn state through the digest, and
  legacy state without a digest takes the complete-history fallback.
- Confirmed no cost-free failure changes turns, summary, tool calls, session
  revision, `updatedAt` or SDK state. Actual compressor/main costs survive
  post-usage failure and cancellation exactly once.

## Commit

- Requested message: `fix: use one conversation history source per request`

## Concerns

- If the chat storage itself remains unwritable, an already incurred provider
  cost can be retained in memory but cannot be guaranteed durable; the recovery
  save is necessarily best effort after an original session-save failure.
- Conversation SDK state remains an exact private artifact by design; this task
  binds reuse to the redacted chat epoch but does not reinterpret or redact the
  SDK's opaque serialized state.
- Verification used deterministic fake OpenRouter clients. No live provider
  call or native cross-platform run is claimed; the one full-suite skip is the
  existing platform-only test.

## Fix Round 1

### Review findings reproduced RED

- Review base: `aba773ef6ed61ca4a717e1ff6543fdc0e7747c03`.
- Before any Fix Round 1 production edit, ran
  `node --import tsx --test tests/agent.test.ts tests/conversation.test.ts`:
  exit 1; 70 tests reached, 65 passed and 5 failed. The five failures are the
  three named behaviors below; the zero-cost parent contains two independently
  failing subcases.
- `a compressor cost-save merge discards the stale compressed seed and
  rebuilds raw merged history` loaded `STALE_COMPRESSED_HANDOFF_SENTINEL` in
  the main call after the compressor-cost save had merged a concurrent turn.
- `StateAccessor load and save isolate committed state from provider-owned
  object mutation` reloaded `MUTATED_PROVIDER_LOAD_SENTINEL` after provider
  mutation and `discard()`, proving the committed object was exposed by
  reference.
- `zero-cost synchronous and streamed main failures are genuine session
  no-ops` failed in both call paths: each added a zero-valued daily bucket and
  changed in-memory `updatedAt`, while the disk artifact remained unchanged.

### Root causes and fixes

- The compressor-cost `SessionStore.save()` result was ignored. Its
  `merged: true` outcome can replace the session history after compression was
  calculated, leaving an old handoff eligible for a fresh seed and later exact
  digest commit. The agent now invalidates old SDK coverage, discards the
  compression success, rebuilds a redacted raw handoff from the merged session,
  and preserves only the already incurred compressor charge. Consequently the
  old handoff cannot become the seed, summary or compaction basis.
- `StateAccessor.load()` returned committed/staged SDK state directly and
  `save()` retained the caller's object. Both directions now cross a deep
  serializable clone boundary using the SDK's own
  serialize/deserialize contract. Provider mutation cannot change committed or
  buffered state after the accessor call.
- `SessionStore.addCost()` accepted zero and therefore created a daily bucket
  and refreshed `updatedAt`. Non-positive and non-finite amounts are now true
  no-ops; existing positive-cost failure/cancellation tests still require each
  actual compressor/main charge exactly once.

### GREEN verification

- Individual regression tests passed after their corresponding minimal fixes:
  merge rebuild 1/1, accessor cloning 1/1, zero-cost failure paths 3/3.
- Required Task 7 focus passed 110/110 with 0 failures.
- Both production and test TypeScript no-emit checks passed.
- Related OpenRouter/session/storage/migration/integration/commands/resume
  regressions passed 138/138 with 0 failures.
- Full `npm test` reached 740 tests: 739 passed, 0 failed and 1 existing
  platform-only skip.
- Central credential fixture scanner/literal audit and `git diff --check`
  passed with no findings.

### Fix Round 1 scope and commit

- Production edits are limited to `src/agent.ts`, `src/conversation.ts` and
  `src/session.ts`; regression edits are limited to `tests/agent.test.ts` and
  `tests/conversation.test.ts`.
- Requested commit message:
  `fix: keep conversation state transactional across merges`.

### Remaining concerns

- The original storage-failure durability limitation remains: if session
  storage itself stays unwritable, an incurred provider charge cannot be
  guaranteed durable beyond memory.
- Tests use deterministic concurrent stores and fake provider calls; no live
  provider or native cross-platform result is claimed.
