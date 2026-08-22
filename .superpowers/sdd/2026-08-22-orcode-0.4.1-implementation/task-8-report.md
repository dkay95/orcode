# Task 8 report

## Status

DONE

## Evidence

### RED

- Required focused command before production edits:
  `node --import tsx --test tests/workspace.test.ts tests/verify.test.ts tests/agent.test.ts tests/tui.test.ts tests/runlog.test.ts`
- Initial exit: 1; 213 tests reached, 203 passed and 10 failed.
- Named missing contracts were live agent process binding/redaction/terminal,
  TUI live/final deduplication and partial-line redaction, verify lifecycle and
  repeated-command IDs, run-command/hardened-Git lifecycle, SSH lifecycle,
  parallel operation IDs, callback-failure isolation, and timeout/no-late
  terminal behavior.
- Reviewer hardening was also demonstrated RED before production fixes:
  parallel identical model tool calls both bound to `tool-1`; terminal-process
  deduplication retained old IDs without a bound; and direct `/verify now`
  emitted no live process lifecycle to the active surface.

### GREEN

- Required focused command: 215/215 passed, 0 failed and 0 skipped.
- Production TypeScript: `npx tsc -p tsconfig.json --noEmit` passed.
- Test TypeScript: `npx tsc -p tsconfig.tests.json --noEmit` passed.
- Commands/approval/policy regressions: 48/48 passed, including direct
  `/diff` and `/verify now` live event paths.
- SSH regressions: 51/51 passed, including one and only one injected SSH
  execution for its streamed lifecycle.
- Routing/config/OpenRouter/models/reasoning regressions: 62/62 passed.
- Full regression: `npm test` reached 754 tests; 753 passed, 0 failed and 1
  existing platform-only skip.
- Central credential-fixture scanner and the literal audit for `sk-or-`,
  `AKIA`, `glpat-` and `npm_` returned no findings.
- `git diff --check` passed.

## Implementation

- Added typed `ProcessOperation`, `ProcessCompletion` and `ProcessCallbacks`
  contracts plus volatile `process-start`, `process-output` and `process-end`
  run events. Each concrete execution gets one UUID that remains stable from
  start through exactly one terminal event.
- Added one observational process wrapper around already-authorized execution.
  It isolates display/log callback failures, suppresses empty or late chunks,
  preserves stdout/stderr arrival order, and never changes the canonical
  process result returned to the model.
- Routed `run_command`, model Git diff, SSH and verification through that
  wrapper. Hardened Git keeps its single central executable resolution,
  filtered environment, disabled pager/external-diff/textconv policy and exact
  approval subject. SSH's observed runner invokes the existing SSH adapter
  once, not once for output and again for the final result.
- Kept browser inspection's pre-existing process-start observation compatible
  with the typed contract and completed it with one success/error terminal.
- Bound process operations to pending model tool IDs without claiming the same
  tool twice under parallel identical calls. Claims remain bounded by one
  agent run and preserve the same tool ID/number on all lifecycle events.
- Redacted process events before the active observer and RunLog receive them.
  Recognizable credential prefixes split across chunks cannot be reconstructed,
  while the canonical tool result remains byte-identical and available to the
  model under the existing outbound-secret warning policy.
- Adapted the existing TUI event bridge, without changing
  `src/ui/view-model.ts`: unbound direct operations become normal tool cards,
  model-bound operations append to their existing card, partial lines are
  reassembled in the event layer, stream switches flush in order, terminal
  events are idempotent, and completed-ID deduplication is capped at 512.
- Routed direct `/diff` through `getGitDiff()` and the same hardened Git event
  path. The fullscreen surface consumes streamed chunks and does not print the
  final diff tail a second time; plain mode keeps its prior single final text.
  Direct `/verify now` uses the same active-surface process callbacks and keeps
  its existing pass/fail summary.
- Hardened `runProcess()` against post-terminal data delivery. Its existing
  process-group timeout/cancellation remains the sole execution path and its
  240,000-character internal stream cap bounds volatile output before the
  existing 80,000-character final tool cap.

## Coverage

- Real POSIX child fixtures separate stdout and stderr across timers and use a
  filesystem liveness barrier to prove the first observer event arrives before
  child exit for run-command, agent and verification paths.
- Lifecycle tests cover ordered streams, empty suppression, one terminal,
  stable operation/tool IDs, repeated verification commands, parallel
  identical calls, callback exceptions, bounded output and no late chunks
  after timeout, cancellation or terminal completion.
- Git tests cover model and direct slash paths through the hardened adapter and
  confirm repository helpers cannot launch. SSH tests prove the same lifecycle
  is observational and does not cause a second remote execution.
- TUI tests cover live visibility, successful-tail deduplication, split-secret
  redaction, partial-line reassembly, terminal idempotence and bounded terminal
  ID retention. RunLog tests cover typed-event JSON/envelope round trips,
  ordered persistence, clone redaction and split credential values.

## Scope

- Planned production files changed: `src/types.ts`, `src/workspace.ts`,
  `src/verify.ts`, `src/agent.ts`, `src/tui.ts` and `src/commands.ts`.
- Planned tests changed: `tests/workspace.test.ts`, `tests/verify.test.ts`,
  `tests/agent.test.ts`, `tests/tui.test.ts`, `tests/runlog.test.ts` and
  `tests/commands.test.ts`.
- Approved narrow runtime dependency: `src/cli.ts` only adds the
  `RuntimeContext.onRunEvent` to active-dashboard hook needed for direct
  process events. No other CLI semantics changed.
- `src/ui/view-model.ts` is intentionally untouched. Approval identity,
  remembered-rule behavior, private persistence/retention and provider routing
  semantics remain unchanged.

## Self-review

- Confirmed process observation begins only after the existing approval/policy
  decision and wraps the one canonical launch.
- Confirmed start/chunk/end IDs are collision-free per operation, tool IDs are
  collision-free under identical parallel calls, and no chunk can mutate a
  terminal lifecycle.
- Confirmed callback exceptions cannot change execution or its returned
  stdout/stderr/exit result.
- Confirmed live events and persisted RunLog envelopes are redacted clones;
  canonical results are neither mutated nor duplicated into a final TUI tail.
- Confirmed `/diff` cannot opt into external diff helpers, remembered mutation
  authority or a separate unobserved spawn.

## Commit

- Requested message: `feat: stream tool and verification output live`

## Concerns

- Real child-process timing and process-group tests are POSIX-only; the full
  suite retains one existing platform-only skip and no native Windows runtime
  result is claimed.
- SSH lifecycle coverage uses the injected runner and exact SSH policy tests;
  no live remote host was contacted.
- This task intentionally renders process lines through the existing tool-card
  model. Broader view-model/UI redesign and global Task 10 hardening remain out
  of scope.
