# Task 10 Report — Runtime safety boundaries

Task 10 was implemented as independently reviewable slices rather than one
cross-cutting commit. The slice-integration base is `113c92e`; the holistic
review closure is recorded below.

## Delivered boundaries

- Automatic Git reads use a fixed minimal environment and fixed read-only
  arguments, reject repository launch configuration, bind the exact outside
  executable and workspace, reject external/common/object metadata delegation,
  and revalidate critical metadata after the visible process-start event and
  immediately before the runner. Component-wise PATH resolution rejects
  workspace-entering symlink and raw-dotdot chains.
- Browser inspection receives the configured executable, timeout, and exact
  root AbortSignal. Per-operation profiles/screenshots are cleaned on every
  terminal path; owned stale browser temp artifacts are pruned at startup with
  visible best-effort warnings.
- CLI, commands, agent, and tools share one live in-memory SSH selection.
  Hostless tool calls resolve it at execution time, explicit hosts win, unknown
  targets fail before approval/spawn, and `/ssh off` disables before awaiting
  close without erasing a newer selection.
- Main models require text input, text output, and tools. Compressor models
  require text output. Exact `openrouter/auto` remains the main-only exception.
  Main, every fallback, and the compressor are validated before a run;
  `/fallback +…` and `--model` validate before any configuration/session
  mutation. Embedded source NUL sentinels were replaced with an injective
  typed tuple key.
- Credential origin, validity, connectivity, credit state, and persistence are
  separate. Saved keys are reused; environment keys remain process-only until
  explicit save; candidate validation is role-scoped; transport/403/credit
  failures do not invalidate a credential; 401 invalidates only the active
  scope. Keychain save/delete uses verified transactional rollback, unsafe
  rollback is never presented as process-only, forget is confirmed, and plain
  offline startup remains interactive with reconnect/status recovery.

## Commits and focused reports

- `ce949a5`, `f75c4b0`: automatic Git boundary and five review rounds
  (`task-10a-report.md`).
- `3b59092`, `20c39c7`: browser artifact lifecycle and shared browser/SSH
  operation state (`task-10b1-report.md`, `task-10b2-report.md`).
- `ddfcb7e`, `27f8ab2`, `113c92e`: role predicates, selection/run gates, and
  final fallback/CLI fail-before-mutation fixes (`task-10c1-report.md`,
  `task-10c2-report.md`, `task-10c-fix-report.md`).
- `b633638`, `c41fc16`: explicit credential/connection state and key lifecycle
  (`task-10d1-report.md`, `task-10d2-report.md`).

## Pre-review integration verification

- Required Task-10 runtime matrix: 209/209 passed.
- Approval/rules/commands/agent/verify/RunLog/TUI matrix: 306/306 passed.
- Production and test TypeScript checks: exit 0.
- Fresh full suite: two consecutive runs each reached 972 tests, with 971
  passed, 0 failed, and 1 existing platform-only skip. The first consolidation
  attempt transiently reported 970/1/1; an immediate diagnostic rerun and the
  following full rerun were both clean, so no stable failing test remained.
- Central credential scanner: no findings. Literal `sk-or-`, `AKIA`, `glpat-`,
  and `npm_` audit: no matches. `git diff --check` and tracked status: clean.
- Independent slice reviews approved Browser/SSH and the final model-routing
  fix with no P0/P1. The holistic final review result is appended below before
  Task 10 is marked complete.

## External limits

- POSIX launcher and process timing tests ran on macOS. Deterministic Windows
  construction/classification tests remain green, but no native Windows result
  is claimed yet; Task 12 owns the Windows CI gate.
- No live SSH host was contacted and no package was published.
- A same-user attacker still has the unavoidable kernel gap between the last
  JavaScript identity check and `spawn(path)`; eliminating it requires a native
  descriptor-bound launcher or the later OS sandbox boundary.

## Holistic review closure

The first holistic review correctly rejected the integrated base on two
remaining boundaries:

1. An authenticated key with no remaining credit was rejected before it could
   be persisted and activated. The focused first-key and dashboard tests were
   RED with `SpendUnavailableError`. Credential activation now authenticates,
   persists, and activates independently of credit; the existing Agent/run
   gates still call `assertSpendAvailable` before any paid model work.
2. The final automatic-Git pass read local configuration before its long
   metadata walk. A real timing fixture changed `.git/config` during that walk
   and the fake runner still started. Repository identity now includes the
   primary config's stable file identity and SHA-256, and reads it after the
   metadata walk. `config.worktree` and `extensions.worktreeConfig` fail closed,
   including a same-line declaration.

A separate Git review then found a late `.git/commondir` layout race. Its timing
fixture was RED before production changes. The child environment now pins
`GIT_COMMON_DIR` to the canonical workspace `.git`, while the adapter checks
`commondir` both before and after the long metadata walk. This closes the
application-level layout window without weakening the earlier metadata and
executable bindings.

Final fresh evidence on the reviewed code:

- Credential/CLI/OpenRouter focus: 128/128 passed.
- Complete workspace suite: 105/105 passed.
- Required Task-10 runtime matrix: 216/216 passed.
- Production and test TypeScript checks: exit 0.
- Full suite: 979 passed, 0 failed, 1 existing platform-only skip (980 total).
- Central credential scanner and literal credential audit: no findings.
- `git diff --check`: clean.
- Independent Git re-review: APPROVED, no P0/P1; its focused matrix passed 7/7.
- Independent final Task-10 re-review: APPROVED, no P0/P1; its combined
  commands/CLI/workspace review passed 177/177 and both TypeScript checks.

No native Windows, live SSH-host, or package-publication result is claimed by
this closure; those remain release-gate work for Task 12.
