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

---

## Fix round 1

### Review RED

- Read `task-8-findings-round-1.md` and the complete implementation ledger,
  then reproduced every finding before its production fix.
- Stateful credential probe: actual RunLog readback and actual TUI rendering
  each failed at `openrouter leaked at split 1`; the matrices cover every split
  of OpenRouter, Anthropic, generic `sk`, AWS ID/secret, GitHub, GitLab, Slack,
  Google, npm, Bearer, JWT and private-key fixtures.
- Invocation probe: two identical parallel `run_command` executions whose
  completion order was deliberately reversed produced terminal IDs
  `tool-1, tool-2` instead of `tool-2, tool-1` under hook/FIFO correlation.
- Direct `/diff` probe: an actual dirty repository terminated as
  `Arbeitsbaum — 0 Diff-Zeilen`; clean and failure distinctions therefore had
  no trustworthy terminal aggregate.
- Final self-review added one further RED barrier: ordinary non-newline output
  was held until process termination instead of reaching the sink while the
  child was alive.

### SDK feasibility and approved identity design

- The pinned `@openrouter/agent` 0.8.0 declarations describe a tool-call item
  on execute context, but the installed runtime passes only turn state into the
  tool and exposes no immutable call identity in Pre/Post hooks. No dependency
  upgrade or patch was made.
- Each actual local tool `execute` now creates exactly one frozen,
  collision-free local invocation UUID plus its stable `tool-N` display ID.
  `AsyncLocalStorage` carries that identity to every descendant process event.
  The same execute wrapper owns start and exactly one success/error terminal;
  Pre/Post hooks no longer create or correlate tool lifecycle events, and the
  old name/input/FIFO maps were removed.
- The local invocation UUID is explicitly not represented as a provider call
  ID. Reverse completion, parallel identical input, process lifecycle binding
  and exactly-one terminal are asserted against the real execute boundary.

### Stateful streaming privacy

- Added one operation-and-stream scoped overlap redactor used by the agent
  observer boundary, direct command event bridge, TUI and RunLog. It retains
  only a possible credential introducer/suffix or incomplete private-key block,
  releases unrelated output live, and flushes retained benign text before the
  terminal event.
- Stateless redaction remains available for non-stream values. Redaction is
  applied only to event clones; canonical `ProcessResult` stdout/stderr remains
  byte-identical for the model and existing outbound warning policy.
- RunLog owns its state across successive writes and flushes it on close. The
  reconstructed flush event preserves invocation/tool identity, stream and
  ordering before the one process terminal.

### Accurate direct `/diff` terminal

- `runObservedProcess` adds independently bounded stdout/stderr aggregates to
  the volatile terminal completion without changing the returned canonical
  process result. Direct `/diff` maps that aggregate to the existing
  `git_diff` metadata, so dirty, clean and non-repository outcomes are accurate.
- Failure summaries report `Git fehlgeschlagen (Exit N)`. The existing view
  model continues to prefer its streamed buffer over the terminal aggregate,
  so the visible tail is not duplicated.
- `/diff` still uses the single hardened Git adapter, filtered environment,
  disabled helper/textconv/pager policy and exact non-rememberable approval
  subject; no second launch or helper path was introduced.

### Fix-round GREEN evidence

- Exact Task 8 focus:
  `node --import tsx --test tests/workspace.test.ts tests/verify.test.ts tests/agent.test.ts tests/tui.test.ts tests/runlog.test.ts`
  passed 220/220, with no skip or failure.
- Every-family/every-split actual RunLog and TUI probes each passed 1/1; the
  ordinary non-line child-liveness barrier, reverse-completion identity probe
  and dirty/clean/failure `/diff` probe each passed 1/1.
- Production and test TypeScript checks both passed.
- Commands/approval/policy passed 38/38 and exact rule regressions 11/11; SSH
  adapter/config/slash regressions passed 47/47 and SSH header regressions 4/4;
  routing/config/OpenRouter/models/reasoning passed 62/62.
- Full `npm test` reached 759 tests: 758 passed, 0 failed and 1 existing
  platform-only skip.
- The central scanner, literal credential-fixture audit and `git diff --check`
  returned no findings.

### Fix-round scope and concerns

- The ledger-approved narrow additions are `src/redaction.ts` for central
  stateful overlap handling and `src/runlog.ts` for persistence stream state.
  `src/ui/view-model.ts`, approvals, remembered rules, private-store retention,
  SDK dependency versions and provider routing remain unchanged.
- Real process timing/reverse-completion tests are POSIX-only. SSH remains
  covered with its injected runner and exact policy tests; no remote host was
  contacted. Global Task 10 hardening and broader UI work remain out of scope.

### Fix-round commit

- Requested message: `fix: preserve streamed secrets and invocation identity`

---

## Fix round 2

### Review RED

- Read `task-8-findings-round-2.md` and the complete implementation ledger,
  then reproduced the cross-stream ordering defect before any production edit.
- Actual RunLog readback failed
  `RunLog keeps later stderr behind an earlier ambiguous stdout prefix`: an
  earlier stdout `eyJ` event at timestamp 11 was retained, later stderr at
  timestamp 12 was persisted first, and the stdout fragment was appended only
  at the process terminal with timestamp 13.
- Actual TUI rendering failed
  `TUI keeps later stderr behind an earlier ambiguous stdout prefix`: the
  visible failure card rendered `ERR-LATER` before the earlier `eyJ` fragment.
- Root cause was the operation's two independent stream redactors. Each stream
  could safely emit by itself, but there was no operation-wide barrier keeping
  a later stream behind an earlier unresolved overlap.

### Global arrival barrier

- Replaced the independent emission path with one insertion-sequenced queue per
  immutable process operation while retaining independent stdout/stderr
  redaction state. A queue head may emit its known-safe prefix immediately, but
  it remains a barrier until its possible credential overlap is resolved.
- Later stdout or stderr entries cannot pass that head. Terminal flushes attach
  retained text to the original output frame, preserving its stream,
  operation/tool/invocation identity and original timestamp, then drain both
  streams in global arrival order before the single terminal event.
- A same-stream arrival that releases the previous ambiguity resolves its old
  barrier; if it ends with a new ambiguity, the new arrival becomes the next
  barrier. Empty output stays suppressed and emitted text is cleared from the
  queue, so no streamed tail can be duplicated at terminal completion.
- Retained barrier state is capped per operation at 480,000 characters and
  2,048 events, matching the two producer stream caps. A direct/adversarial
  caller crossing the bound has the unresolved fragment replaced rather than
  released, so future chunks cannot reconstruct it across the forced boundary.
- The fix is confined to the ledger-approved central streaming privacy layer,
  `src/redaction.ts`; RunLog, TUI, process producers, canonical `ProcessResult`,
  approvals, persistence/retention and view-model semantics are unchanged.

### Fix-round GREEN evidence

- The two exact review probes each passed 1/1. The TUI probe additionally
  asserts that later stderr is not visible before the earlier stdout overlap is
  resolved; RunLog readback asserts stdout/stderr attribution and timestamps
  11 then 12.
- Every-family/every-split credential probes passed 1/1 through actual TUI and
  1/1 through actual RunLog. The real-child ordinary non-line liveness barrier
  passed 1/1, proving safe output still reaches the observer before child exit.
- Exact Task 8 focus
  `node --import tsx --test tests/workspace.test.ts tests/verify.test.ts tests/agent.test.ts tests/tui.test.ts tests/runlog.test.ts`
  passed 222/222 with no failure or skip.
- Production and test TypeScript checks both passed.
- Commands/approval/policy passed 38/38 and exact rules passed 11/11. SSH
  adapter/config/slash passed 47/47 and SSH UI passed 4/4. Routing/config,
  OpenRouter, models and reasoning passed 62/62.
- Full `npm test` reached 761 tests: 760 passed, 0 failed and 1 existing
  platform-only skip.
- The central scanner returned no credential findings; the literal audit for
  `sk-or-`, `AKIA`, `glpat-` and `npm_` returned no matches; and
  `git diff --check` passed.

### Fix-round self-review and concerns

- Confirmed the operation queue is drained only from its head; a later stream
  therefore cannot become visible or persisted while an earlier overlap is
  unresolved. Safe text at the head remains live.
- Confirmed terminal flushing reuses the original output frame and timestamp,
  emits held output before the one terminal, and clears each emitted segment so
  terminal completion cannot duplicate a streamed tail.
- Confirmed state is isolated by operation and stream, and bound enforcement
  destroys rather than exposes an unresolved credential fragment.
- The existing real process timing probes remain POSIX-only, with the same one
  platform skip in the full suite. No remote SSH host was contacted. Broader UI
  partial-line/view-model changes and global Task 10 hardening remain out of
  scope.

### Fix-round commit

- Requested message: `fix: preserve cross-stream process event order`

---

## Fix round 3

### Review RED

- Read `task-8-findings-round-3.md` and the complete implementation ledger,
  then reproduced the retained-fragment provenance defect through both actual
  consumers before changing production code.
- Actual RunLog readback failed
  `RunLog preserves retained stdout provenance when a same-stream chunk resolves mid-process`:
  stdout `eyJ` at timestamp 11 was combined with the resolving stdout frame at
  timestamp 13, after intervening stderr at timestamp 12. The observed order
  was stderr 12, then `eyJ benign` as stdout 13 instead of stdout 11, stderr 12,
  stdout 13.
- Actual TUI rendering failed
  `TUI preserves retained stdout provenance when a same-stream chunk resolves mid-process`:
  the visible running card rendered `ERR-LATER` before the combined
  `eyJ benign` stdout text.
- Root cause was `StreamingTextRedactor.push()` returning one un-attributed
  string. Once an old retained prefix and current bytes were released together,
  the operation queue could attach only that combined string to the current
  frame; original frame and timestamp provenance had already been erased.

### Provenance-aware release

- Streaming redaction now retains attributed text segments carrying the
  immutable process-arrival sequence. Redaction still runs against the
  concatenated stream, but untouched slices are mapped back to their source
  segments and released into the original queue entries.
- The operation-wide barrier is derived from the earliest still-pending
  attributed segment. Resolving an old stdout prefix therefore makes that old
  frame ready first; intervening stderr remains next; bytes originating in the
  resolving stdout arrival remain on the current frame. Stream, original
  timestamp, global arrival order and byte order are preserved.
- Terminal flush and bounded-fragment destruction use the same attributed
  output path. Empty frames remain suppressed, emitted text is cleared before
  queue removal, and the canonical `ProcessResult` remains unchanged.
- The existing 2,048-event / 480,000-character operation bound is retained. An
  adversarial bound probe released one old-frame
  `[REDACTED_STREAM_FRAGMENT]`, then all 2,050 stderr frames in order, exposed
  no ambiguous `eyJ` fragment and emitted exactly one terminal event.

### Redaction-marker self-review

- A focused self-review probe first failed
  `RunLog emits one redaction marker while preserving AWS label provenance`:
  the attributed AWS `$1` replacement was processed again by the streaming
  partial rule, producing duplicate redaction markers and assigning one to the
  resolving frame.
- The AWS partial rule is now idempotent for its existing marker. Captured label
  bytes retain their source attribution, the one synthetic marker uses the
  label's final-byte provenance, sensitive body bytes are discarded and a
  current-origin newline remains on the current frame.
- The agent integration assertion now accepts one or more provenance-preserving
  process-output frames between its start and end, while still requiring one
  stable operation/tool identity, exactly one terminal, no post-terminal
  output, complete split-secret redaction and a byte-identical canonical result.

### Fix-round GREEN evidence

- The two exact review probes passed 2/2. The RunLog result is stdout `eyJ` at
  timestamp 11, stderr at timestamp 12 and current stdout at timestamp 13; the
  TUI renders the same order and keeps stderr invisible while the earlier
  stdout ambiguity is unresolved.
- Every-family/every-split credential probes passed 1/1 through actual TUI and
  1/1 through actual RunLog. The real-child ordinary non-line liveness barrier
  passed 1/1, and terminal/bound behavior remained green.
- Exact Task 8 focus
  `node --import tsx --test tests/workspace.test.ts tests/verify.test.ts tests/agent.test.ts tests/tui.test.ts tests/runlog.test.ts`
  passed 225/225 with no failure or skip.
- Production and test TypeScript checks both passed.
- Commands/approval/policy passed 38/38 and exact rules passed 11/11. SSH
  adapter/config/slash passed 47/47 and SSH UI passed 4/4. Routing/config,
  OpenRouter, models and reasoning passed 62/62.
- Full `npm test` reached 764 tests: 763 passed, 0 failed and 1 existing
  platform-only skip.
- The central scanner returned no credential findings; the literal audit for
  `sk-or-`, `AKIA`, `glpat-` and `npm_` returned no matches; and
  `git diff --check` passed.

### Fix-round scope and concerns

- Production changes remain confined to the approved central streaming
  privacy layer, `src/redaction.ts`; tests changed only the Task 8 agent,
  RunLog and TUI coverage. RunLog storage, TUI/view-model code, process
  producers, approvals, remembered rules, private persistence/retention and
  provider routing remain unchanged.
- The existing real process timing probes remain POSIX-only, with the same one
  platform skip in the full suite. SSH remains covered through injected runner
  and exact policy tests; no remote host was contacted. Broader UI work, Task 9
  repair and global Task 10 hardening remain out of scope.

### Fix-round commit

- Requested message: `fix: preserve streamed fragment provenance`

---

## Fix round 4

### Review RED

- Read `task-8-findings-round-4.md` and the latest implementation-ledger
  entry, verified the exact clean base
  `ee695bea1dc6a6299240569965d7c81f1d5fccda`, and changed no production code
  before reproducing the finding through both actual consumers.
- `RunLog emits exactly one AWS marker with original frame provenance across every capture split`
  failed at `aws-spaced-double-value-23`: one credential persisted two markers,
  one on old stdout timestamp 321 and one on current stdout timestamp 323,
  with intervening stderr correctly retained at timestamp 322.
- `TUI emits exactly one AWS marker in original output order across every capture split`
  failed on the same optional-whitespace/value-quote boundary and visibly
  rendered both markers around the intervening stderr line.
- The fail-first matrix covers bare and spaced labels, optional double/single
  key and value quotes, colon/equal separators, spaces/tabs, case and separator
  variants, and every split from the first captured byte through the complete
  capture. It independently asserts one marker, no secret bytes and original
  frame/stream/timestamp/arrival provenance.

### Root cause and minimal fix

- Stateful attributed redaction had already removed the AWS secret and placed
  one marker on the frame owning the capture's final byte. The safe text was
  then passed through whole-event stateless redaction at three boundaries:
  `ProcessEventRedactor.#outputEvent`, TUI process application and RunLog
  serialization. A frame ending at `aws_secret_access_key =` lacked the later
  frame's marker context, so the partial rule created a second marker.
- `ProcessEventRedactor` now stateless-redacts a clone of the output template
  whose text is empty, then restores only the attributed, statefully safe
  `buffered.text`. IDs, names, tool/invocation fields and timestamps still pass
  through central event-field redaction, while safe text is not reclassified
  out of its cross-frame context.
- The private TUI process path now consumes the event returned by its own
  `ProcessEventRedactor` directly instead of redacting that event a second
  time. No view-model or partial-line behavior changed.
- Live RunLog writes and close-time flushes mark only events returned by their
  owned `ProcessEventRedactor` as already redacted when serializing. The raw
  `RunLog.appendRunEvent` path retains the default full stateless redaction, so
  an arbitrary standalone event cannot bypass persistence privacy.
- The RunLog matrix places a separate synthetic credential in output-event
  metadata and verifies it remains redacted in readback and raw NDJSON while
  the attributed AWS output retains exactly one marker. Canonical
  `ProcessResult`, producers, approvals and terminal semantics are unchanged.

### Fix-round GREEN evidence

- The two exact fail-first RunLog/TUI review probes passed 2/2 after the
  production fix.
- The named privacy/provenance/live/terminal selection passed 14/14, including
  every-family/every-split TUI and RunLog privacy, cross-stream barrier and
  mid-stream provenance, ordinary child-live output, verification liveness,
  bounded stable operation IDs, timeout late-chunk rejection and one terminal.
- The direct 2,048-event bound probe emitted one old-frame
  `[REDACTED_STREAM_FRAGMENT]`, all 2,050 stderr frames in order, no retained
  `eyJ` bytes and exactly one final terminal (`2,051` output events total).
- Exact Task 8 focus
  `node --import tsx --test tests/workspace.test.ts tests/verify.test.ts tests/agent.test.ts tests/tui.test.ts tests/runlog.test.ts`
  passed 227/227 with no failure or skip.
- Production and test TypeScript checks both passed.
- Commands/approval/policy passed 38/38 and exact rules passed 11/11. SSH
  adapter/config/slash passed 47/47 and SSH UI passed 4/4. Routing/config,
  OpenRouter, models and reasoning passed 62/62.
- Full `npm test` reached 766 tests: 765 passed, 0 failed and 1 existing
  platform-only skip.
- The central scanner returned no credential findings; the literal audit for
  `sk-or-`, `AKIA`, `glpat-` and `npm_` returned no matches; and
  `git diff --check` passed.

### Fix-round scope and concerns

- Production changes are limited to the existing central redactor and its two
  actual consumers: `src/redaction.ts`, `src/runlog.ts` and `src/tui.ts`.
  Tests changed only RunLog and TUI capture-boundary coverage. RunLog envelope
  schema, private-store retention, TUI view model, process producers, canonical
  results, approvals, remembered rules and routing remain unchanged.
- The existing real process timing probes remain POSIX-only, with the same one
  platform skip in the full suite. SSH remains covered through injected runner
  and exact policy tests; no remote host was contacted. Task 9 repair, broader
  UI work and global Task 10 hardening remain out of scope.

### Fix-round commit

- Requested message: `fix: avoid double-redacting streamed output`
