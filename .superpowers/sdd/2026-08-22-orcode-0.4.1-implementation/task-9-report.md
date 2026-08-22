# Task 9 report

## Status

DONE

## Base and design check

- Work started on branch `codex/orcode-0.7-design` at the exact clean base
  `726e44c4a5ffdd67dfdb3e58eb9d7dbce57d048e`.
- The implementation plan, specification section 7.6 and its global
  finalization/budget invariants, Task 9 brief, current ledger, and Task 7/8
  reports were read before edits.
- No genuine design conflict was found. The approved design is internally
  consistent when repairs are model phases inside one root run, conversation
  and session persistence stay at the root boundary, and verification uses
  Task 8 process events without a second verify card.

## Evidence

### RED

- Independent fail-first slice before any production edit:
  `node --import tsx --test tests/config.test.ts tests/verify.test.ts tests/workspace.test.ts tests/conversation.test.ts`
  reached 128 tests: 112 passed and 16 failed.
- The named missing contracts were:
  `validateVerify allows zero through two repair rounds and normalizes the mode`;
  `validateVerify migrates legacy total-pass maxRounds without raising the limit`;
  legacy load/save-new-only coverage; canonical validator zero/ceiling,
  migration, mixed-field and invalid-field behavior; typed timeout and spawn
  failure; redacted compact repair reports; run-specific ChangeJournal
  mutation queries; transient conversation continuation; and discard restoring
  the prior committed SDK state.
- Agent fail-first slice before editing `src/agent.ts`:
  `node --import tsx --test --test-name-pattern='Task 9' tests/agent.test.ts`
  reached 13 subtests: 2 passed and 11 failed.
- The two already-green controls were no current-run edit and an old-run-only
  journal entry. The eleven RED behaviors were edited mode-off/no-command
  outcomes, fail-repair-green continuation, cumulative cost/steps, repair/pass/
  process exhaustion, step/cost refusal, timeout, spawn failure, and root
  cancellation.

### GREEN

- Exact required primary gate:
  `node --import tsx --test tests/config.test.ts tests/verify.test.ts tests/agent.test.ts tests/workspace.test.ts tests/tui.test.ts tests/runlog.test.ts`
  passed 270/270 with no failure or skip.
- Exact required conversation/command gate:
  `node --import tsx --test tests/conversation.test.ts tests/commands.test.ts`
  passed 24/24 with no failure or skip.
- The complete Task 9 agent matrix passed 17/17, including immediate green,
  zero repair rounds, fail-repair-green, exact hard bounds, typed terminal
  verification failures, cancellation, and repair-model rollback with positive
  incurred-cost persistence.
- Privacy/process/conversation regressions passed 242/242.
- Routing/resume/config-migration/command regressions passed 119/119.
- Config/commands/integration/verify/conversation regressions passed 88/88.
- Production TypeScript and test TypeScript both passed with no diagnostics.
- Full `npm test` reached 794 tests: 793 passed, 0 failed and 1 existing
  platform-only skip.
- The central credential-fixture scanner returned no findings. The literal
  audit for `sk-or-`, `AKIA`, `glpat-` and `npm_` returned no matches (the
  expected `rg` exit code was 1 with empty output).
- `git diff --check` passed.

## Implementation

- Renamed the persisted/runtime verify property to `maxRepairRounds`, allowed
  `0..2`, and made `validateVerify` the single canonical validator. Raw legacy
  `maxRounds: N` becomes `maxRepairRounds: max(0, N - 1)`; an explicit new
  field wins, saving emits only the new field, and the shared config/storage
  schema version was not changed.
- Updated `/verify rounds` to accept zero, render repair-round semantics, retain
  the ceiling of two, and report typed timeout/spawn/cancellation results for
  direct runs.
- Added an exact-run `ChangeJournal.hasMutations(runId)` query. Verification is
  skipped for no-edit runs and cannot be triggered by an older run's entries;
  every initial and repair edit retains the same root run ID and checkpoint.
- Classified one verification pass as passed, ordinary failed exit, timed out,
  spawn/resolution failed, or cancelled. Only the ordinary nonzero exit may
  request repair. Each command remains on Task 8's one ordered and bounded
  start/output/end lifecycle and passes fail-fast in configured order.
- Redacted verification failures at the verifier boundary and again before the
  provider-facing repair item. Reports are capped to twelve diagnostic lines
  and 4,000 characters in the verifier; repair input further caps the command
  and report and contains no original prompt or attachment.
- Refactored the main agent call into a root-owned model-phase runner. The
  initial phase and all permitted repairs reuse one route, instructions, tools,
  journal, abort signal, tool sequence, process callbacks and event sequence.
  The compressor, project-history decision, current user request and attachments
  occur only once. Repairs are never recursive `#run()` calls.
- Each phase receives only the remaining root model steps and main-model cost.
  Model events use monotone phase offsets, tool IDs remain cumulative, and a
  repair is refused when the root step/cost remainder or configured repair
  count is exhausted.
- Added the minimal `ConversationStore.stageContinuation()` seam. It clones the
  first phase's buffered SDK state for the next repair without disk I/O. The
  repair input is one transient developer item; root success saves the session
  and commits conversation state once, while cancellation or model failure
  restores staged session data, discards all transient SDK state and best-effort
  persists genuinely incurred positive provider cost.
- Root finalization emits one terminal event. A mutating run is complete only
  after a green pass; mode-off, no-command, typed verification failures and
  exhaustion are unverified; abort is cancelled. Automatic verification passes
  an empty legacy verify-event callback, so process events are the sole command
  cards and there is no duplicate tail.

## Coverage

- Config tests cover default, zero, ceiling, invalid values, legacy 1 -> 0 and
  2 -> 1, explicit-new precedence, idempotent reload, save-new-only and future
  schema refusal. Command tests cover rounds zero, status and upper bound.
- Agent tests cover no edit, old-run-only edits, mode off, no commands,
  immediate green, zero repairs, fail-repair-green, three-pass/two-repair hard
  bounds, ordered fail-fast child starts, step/cost exhaustion, timeout, spawn
  failure, cancellation and repair-model failure rollback.
- Captured model requests prove the user request and image attachment appear
  once, repair input has exactly one developer role, repair state sees the
  first phase buffer, credentials are absent, steps/cost/tool IDs are monotone,
  and one root commit/revision/run-end is produced.
- Verify/process tests cover cancellation before, during and between commands,
  typed timeout/spawn failure, no late output and bounded compact reports. TUI
  and RunLog tests prove one process card/lifecycle and one unverified terminal
  without a legacy verify card or duplicated output.
- Task 7 transaction and Task 8 live-process/privacy suites remained green.

## Scope

- Planned production files changed: `src/agent.ts`, `src/config.ts`,
  `src/verify.ts`, `src/commands.ts`, and `src/workspace.ts`.
- Approved minimal conversation seam: `src/conversation.ts` and
  `tests/conversation.test.ts`.
- Planned tests changed: `tests/config.test.ts`, `tests/verify.test.ts`,
  `tests/agent.test.ts`, `tests/workspace.test.ts`, `tests/tui.test.ts`, and
  `tests/runlog.test.ts`; approved command coverage changed
  `tests/commands.test.ts`.
- Approved mechanical compatibility edit: `tests/integration.test.ts` changes
  only the renamed property assertion and zero-inclusive validation copy. It
  introduces no new integration behavior.
- `src/types.ts` was intentionally left byte-identical: the Task 8 base already
  carried `unverified` in the run-end event union. The run-result union that
  still needed the value is owned by `src/agent.ts` and was extended there.
- No shared storage schema, approval/rule semantics, provider routing, process
  runner, TUI production code, RunLog production code or SDK dependency was
  changed.

## Self-review

- Confirmed `covers()` and history reset execute only before the initial model
  phase; repair phases use cloned transient state and never recompute history.
- Confirmed session save and conversation commit/discard exist only at the root
  boundary, with one commit for completed or unverified non-cancelled roots and
  discard on model failure/cancellation.
- Confirmed only `status: failed` can enter the repair branch; timeout,
  spawn/resolution failure and cancellation cannot consume a repair call.
- Confirmed the repair/pass/process bounds are structural in the loop and also
  asserted at their exact maxima; all repairs reuse the root run ID and tool
  sequence.
- Confirmed provider repair capture, observer events, rendered TUI and RunLog
  contain no synthetic credential, while live process output remains visible
  before exit through the existing redacted stream boundary.
- Confirmed no recursive root call, second terminal event, legacy verify card,
  second compressor call, duplicate user turn, prompt or attachment exists.

## Commit

- Requested message: `feat: verify edited runs with bounded repair`

## Concerns

- Real child-process cancellation/timing probes are POSIX-only; the full suite
  retains one existing platform-only skip and no native Windows runtime result
  is claimed.
- Model/provider interactions are covered with deterministic injected clients
  and process runners; no paid live provider call was made.
- As before, provider cost is reported after calls. The SDK receives the exact
  remaining per-phase limit and no later repair starts after exhaustion, but a
  provider can only be charged from the actual usage it eventually reports.
