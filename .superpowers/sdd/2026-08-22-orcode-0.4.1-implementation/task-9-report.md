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

## Fix Round 1 — scope ruling

- Review required an invalid configured shell to expose one redacted reason in
  the existing process card and RunLog. The structured process-end error
  already reached both consumers, but `exitCode: null` was classified by
  `src/ui/view-model.ts` as an unverified collapsed card and its tail was
  hidden.
- The controller therefore approved the minimal out-of-brief renderer edit and
  focused TUI assertion: an explicit completion error is a failed process card
  with its one redacted line visible, without inventing an exit code, adding a
  Verify card, or duplicating the tail. The risk is a state change only for
  structured launch-error cards; the invalid-shell one-card/one-tail probe,
  Task-9 TUI/RunLog focus, and full suite are the binding gates.

## Fix Round 1 — verification terminal failures

Base: clean `9e14260a0b9a64415aacc3cd9e4bfe4a47387034`.

### Findings and RED evidence

- A root abort raised synchronously by `onProcessEnd` was observed after the
  verifier returned, so exit 0 committed staged state and exit 1 could enter a
  repair before the root noticed cancellation. The named real-verifier/root
  probes produced 3/3 failures (one parent and two exit-code subtests).
- Signal termination and genuine command-resolution failures lost their cause
  in `ProcessResult`; both could collapse into ordinary nonzero exits. The
  named verifier matrix for abort, real POSIX signal, real POSIX missing
  command, deterministic Windows equivalents, and invalid `ORCODE_SHELL`
  produced 9/9 failures before production edits.
- Subsequent bounded RED slices proved the remaining public surfaces: direct
  `/verify now` signal reporting failed 1/1, the ordinary-exit-127 and
  PowerShell classification controls failed 3 of 5, the invalid-shell TUI
  reason failed 1/1, and an exit-0 diagnostic-text false-positive control
  failed 1/1.

### Implementation

- `ProcessResult` now retains a POSIX signal and a compact launch/resolution
  error. The observed runner owns exactly one start/end lifecycle even when
  shell resolution or spawn fails; timeout, abort, signal, launch failure, and
  ordinary exit remain distinct.
- The verifier resolves the configured shell inside the observed operation,
  sanitizes its terminal reason, rechecks root cancellation after the observed
  await, and classifies only an ordinary proven test nonzero as `failed` and
  repairable. Genuine POSIX/cmd/PowerShell resolution evidence and signal
  termination are typed `terminated`/`spawn-failed` and remain unverified.
- The root rechecks cancellation before interpreting verification, before
  repair dispatch, and before the one Session/Conversation commit boundary.
  Cancellation discards staged state and starts no repair while retaining only
  genuinely incurred positive provider cost.
- Direct `/verify now` renders a typed signal termination honestly. This
  `src/commands.ts` change is mechanical exhaustiveness for the new verifier
  outcome and the focused command test protects the user-visible contract; it
  does not widen command semantics.
- `src/types.ts` carries the already-produced signal through the existing
  process event contract. The focused workspace, verifier, Agent, command, and
  TUI tests are the smallest proof surfaces for the three review findings.
- Per the recorded scope ruling, `src/ui/view-model.ts` treats only an explicit
  structured completion error with no exit code as a failed process card and
  displays its already-redacted line. It invents no exit code, adds no Verify
  card, and preserves the one-card/one-tail layout. The cost is limited to
  structured launch-error cards and is covered by the focused TUI/RunLog and
  full regressions.

### GREEN evidence

- Exact Task-9 primary focus (`config`, `verify`, `agent`, `workspace`, `tui`,
  `runlog`): 291/291 passed.
- Conversation and command focus: 25/25 passed.
- Privacy/process/conversation focus (`redaction`, `secrets`, `session`,
  `workspace`, `agent`, `tui`, `runlog`, `conversation`): 296/296 passed.
- Routing/resume/config/command focus (`config`, `commands`, `resume`,
  `openrouter`, `models`, `reasoning`): 102/102 passed.
- Both TypeScript checks passed. Full `npm test`: 815 passed, 0 failed, and 1
  existing platform-only skip (816 total).
- Central credential scanner, literal credential audit, and
  `git diff --check`: passed.

### Self-review and limits

- Confirmed a synchronous abort from process end wins for both exit 0 and exit
  1, produces one cancelled root terminal, starts no repair, and commits no
  staged Session/Conversation state.
- Confirmed real POSIX signal and missing-command paths plus invalid configured
  shell produce one process terminal and one unverified root terminal, with no
  repair. The compact visible reason passes through the existing central
  redaction boundary and is neither duplicated nor expanded into a second
  card.
- Confirmed explicit `exit 127` without resolution evidence remains an
  ordinary repairable failure, while diagnostic-looking text from exit 0 is
  still a pass. Windows cmd/PowerShell/launch causes are tested
  deterministically; no native Windows execution is claimed.
- Confirmed the Task-7 one-history transaction and Task-8 process lifecycle,
  streaming redaction, and single-terminal invariants remain covered by the
  focused and full gates.

Requested commit: `fix: keep verification terminal failures unrepairable`.

## Fix Round 2 — structured process launch failures

Base: clean `099036aa9cabef34de59bd77eb2f3d2925ca4874`.

### Findings and RED evidence

- Ordinary child output was still treated as authority for command resolution:
  explicit exit 127/1 could become non-repairable merely by printing phrases
  such as `not found` or `CommandNotFoundException`. A real executable launch
  error also invented exit code 1, and `run_command`/SSH discarded its
  structured cause. The initial named Round-2 selection reached 7 tests: 2
  passed and the 5 intended assertions failed before production edits.
- The first implementation used one POSIX-oriented PATH preflight for every
  shell. Fail-first probes showed valid `dir` and `Get-ChildItem` commands being
  rejected; the shell-native selection reached 3 tests with 0 passes and 3
  failures.
- Review then exposed two further authority errors: inspecting only the first
  segment changed the actual result of `missing || true`/`;`/pipelines, while
  PowerShell language constructs such as `exit`, `throw`, and a quoted
  expression were sent to `Get-Command`. The combined adversarial selection
  reached 13 tests: 3 passed and 10 failed before the final production fix.

### Implementation

- `ProcessResult.code` is nullable. A real spawn error now returns
  `code: null` with one compact centrally redacted `launchError`;
  `runObservedProcess` emits exactly one `exitCode: null` terminal. Existing
  public tool schemas stay numeric because `run_command` and SSH throw the
  retained cause only after that observed terminal.
- Verification no longer infers authority from stdout or stderr. It preflights
  only a strictly simple, literal top-level command. Compound commands,
  assignments, wrappers, redirections, expansions, and language expressions
  run normally and keep the shell's actual final exit semantics.
- Resolution is shell-causal: a POSIX shell resolves the token in the same
  no-profile shell via a silent `command -v` probe; cmd uses its finite native
  command set plus executable-path resolution; PowerShell uses an encoded
  `Get-Command` probe only for command-shaped tokens. PowerShell keywords,
  quoted/numeric expressions, and cmd/POSIX native commands bypass external
  executable classification.
- The bound UI path keeps the process terminal attached to its tool card, then
  renders one tool-error cause. RunLog persists the structured process/tool/root
  lifecycle with the cause redacted. Unbound verify, real `run_command`, and
  SSH paths retain the same one-start/one-end contract.

### GREEN evidence

- Final shell-authority matrix: 19/19 passed, including deceptive output,
  simple missing commands, POSIX/cmd/PowerShell native commands, compound and
  wrapped POSIX semantics, and PowerShell language constructs.
- Independent final re-review passed 33/33 adversarial probes with no open
  Critical or Important finding.
- Complete verifier suite: 55/55 passed. Task-9/Task-8 process, SSH, TUI,
  RunLog, conversation, config, and command focus: 346/346 passed.
- Both TypeScript checks passed. Full `npm test`: 836 passed, 0 failed, and 1
  existing platform-only skip (837 total).
- Central credential scanner and literal credential audit returned no findings;
  `git diff --check` passed.

### Self-review and limits

- Bound TUI and RunLog tests prove one visible cause, one process terminal, one
  root terminal, `exitCode: null`, and central redaction without a duplicate
  tail. Real post-approval POSIX ENOENT covers `run_command`; SSH and Windows
  shell behavior use deterministic injected runners.
- Ambiguous shell programs deliberately receive no preflight classification:
  their actual exit remains repairable or successful exactly as the configured
  shell reports it. This prevents the preflight from becoming a second parser
  with different semantics.
- No native Windows or live SSH-host result is claimed. The existing native
  Windows platform test remains the single expected skip on this macOS host.

Requested commit: `fix: preserve structured process launch failures`.

## Fix Round 3 — literal command identity with opaque arguments

Base: clean `9a039bf2b416383945f7db003a16e049ef7d53c0`.

### Finding and RED evidence

- The strict preflight rejected a command whenever any argument contained a
  metacharacter. That made a genuinely missing simple command repairable when
  only an argument contained a quoted glob or Windows path. The named POSIX,
  PowerShell, and cmd selection reached 4 tests with 0 passes and 4 failures
  before the production change.
- A delayed independent review found that the first correction was still too
  conservative for unquoted POSIX globs and escaped-space arguments, while it
  incorrectly treated PowerShell dot-sourcing and a cmd `::` comment as
  executable heads. The expanded shell-native selection reached 16 tests: 9
  passed and 7 failed, covering four failing leaf behaviours, before the final
  production correction.
- The next re-review found four more cmd-native forms (`C:`, `cd..`, `cd\`,
  and `dir/w`) that an exact-name-only native-command set still sent to
  executable resolution. Their dedicated RED reached 9 tests: 4 passed and 5
  failed, with all four new leaf behaviours failing before implementation.
- The same re-review then proved that a real relative cmd executable was
  resolved against the RouterCode launcher directory rather than the selected
  verification workspace. The named workspace-binding test failed 0/1 before
  implementation: the command became `spawn-failed` and the main shell call
  never ran.

### Implementation

- The verifier now parses only the literal first shell word. Shell-specific
  quoting and expansion characters remain conservative for command identity,
  while argument bytes such as quoted or unquoted globs, escaped spaces, and
  Windows paths no longer erase that identity.
- A separate shell-aware suffix scan rejects only syntax that can change the
  top-level execution contract: chains, pipelines, redirections, grouping, or
  malformed quotes. It tracks shell-native quotes and escapes but otherwise
  keeps argument contents opaque. PowerShell dot-sourcing and cmd labels or
  comments remain owned by their actual shells. Compound/wrapper semantics
  from Round 2 remain owned by the actual shell.
- Cmd native detection now also recognizes drive switches, attached
  slash-option forms, and the narrow glued `cd`/`chdir`, `echo`, and
  `rem` language forms. It does not treat arbitrary command-name prefixes as
  native.
- `resolveExecutablePath` accepts an optional resolution cwd, and verification
  passes its canonical workspace root through the cmd preflight. Existing
  callers retain the process-cwd default; relative verification executables no
  longer depend on where RouterCode itself was launched.

### GREEN evidence and limits

- Expanded shell-authority matrix: 30/30 passed. Complete verifier: 68/68
  passed. Primary Task-9/process focus: 324/324 passed.
- Independent final re-review found no Critical or Important issue. Its focused
  shell matrix passed 28/28, targeted workspace/verify resolution passed
  17/17, and direct probes kept cmd-native forms in the shell while sending
  actual relative executable paths through the workspace-bound resolver.
- Both TypeScript checks passed. Full `npm test`: 849 passed, 0 failed, and 1
  existing platform-only skip (850 total). The central credential scanner,
  literal credential audit, and `git diff --check` passed.
- The implementation remains deterministic for cmd/PowerShell on this macOS
  host; no native Windows execution is claimed.

Requested commit: `fix: keep verify argument syntax opaque`.
