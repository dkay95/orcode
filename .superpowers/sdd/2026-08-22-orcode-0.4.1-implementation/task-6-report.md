# Task 6 report

## Status

DONE

## Evidence

### RED

- Required focused command:
  `node --import tsx --test tests/runlog.test.ts tests/workspace.test.ts tests/conversation.test.ts tests/session.test.ts tests/agent.test.ts tests/commands.test.ts tests/cli.test.ts`
- Initial exit: 1; 178 tests reached, 166 passed and 12 failed before
  production edits.
- The named failures covered redacted age/count/active/global retention, exact
  age/terminal-run/global retention, migration-backup retention, atomic chat
  rebinding, startup and successful-run pruning, single-confirmation deletion,
  idempotent removal, and registry/mapped-legacy deletion.
- Additional test-only RED coverage was added before its corresponding fixes:
  - terminal-run counting groups multiple exact files by run rather than file;
  - a failed `setSession()` retains the complete old binding;
  - partial deletion retains a retryable canonical transcript and active-chat
    deletion cannot be resurrected by autosave;
  - mapped legacy deletion accepts only a validated completed manifest and
    preserves non-chat backup content;
  - returned flat/nested retention errors are surfaced, not silently ignored;
  - a run-log close failure prevents successful-run pruning;
  - a mapped legacy transcript failure cannot remove the canonical retry anchor.
- Focused returned-report RED: 1 reached, 0 passed.
- Run-log-close RED: 40 reached, 39 passed and 1 failed.
- Mapped-legacy retry-anchor RED: 1 reached, 0 passed.

### GREEN

- Required focused command: 185/185 passed, 0 failed.
- Production TypeScript: `npx tsc -p tsconfig.json --noEmit` passed.
- Test TypeScript: `npx tsc -p tsconfig.tests.json --noEmit` passed.
- Related integration/resume/TUI/migration/private-store suites: 132 reached,
  131 passed, 0 failed, 1 Windows-only skip.
- Full regression: `npm test` reached 710 tests; 709 passed, 0 failed and 1
  Windows-only skip.
- Central credential-fixture audit:
  `rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' 'sk-or-|AKIA|glpat-|npm_' tests README.md`
  returned no matches.
- `git diff --check` passed.

## Implementation

- Added deterministic, registry-driven retention for redacted run logs: the
  fixed ceilings are 30 days, 100 terminal logs per chat and 500 MiB globally,
  with downward-only finite configuration, oldest-first ties by path, active
  run exclusion, and per-path error reports.
- Added registry-driven exact retention for journals/checkpoints, SDK state and
  future task sidecars: 14 days, 20 terminal runs per chat and 250 MiB globally.
  Multiple exact files sharing one run ID count as one run. Active artifacts are
  excluded and all deletion crosses a root-scoped `PrivateStore` boundary.
- Added managed migration-backup retention: at most one backup per source, 30
  days and 250 MiB globally, downward-only configuration, deterministic
  oldest-first deletion and active-manifest/explicit-active exclusion.
- Extended the artifact registry with safe global enumeration and actual
  reserved-sidecar discovery. Added a bound exact artifact store so future
  task-sidecar writers participate in rebinding, retention and deletion without
  another guessed path.
- Reworked `OrcodeAgent.setSession()` around one all-or-nothing binding for the
  session, change journal, SDK conversation, checkpoints/run identity and task
  sidecars. A replacement that cannot bind leaves the old binding intact.
- Centralized idempotent chat deletion across every registry-owned artifact,
  validated mapped-legacy entries and empty managed backups. Sidecars and mapped
  transcripts are removed before the canonical transcript; partial cleanup
  retains the canonical retry anchor. Config/rule/non-chat backups survive.
- Added exactly one explicit deletion confirmation in plain and fullscreen
  command flows. Decline is non-mutating. Active-chat acceptance switches to a
  fresh session without saving the deleted store, preventing resurrection.
- Startup waits for migration readiness, then runs both retention classes before
  opening config/rules/session stores. A successful run prunes only after SDK
  state commit, terminal run-end write and successful log close. Failed,
  cancelled, active or unclosed runs do not trigger successful-run pruning.
- Both thrown failures and returned flat/nested per-class retention errors are
  surfaced best effort at startup and after a successful run.

## Self-review

- Confirmed configured ceilings reject upward expansion, non-finite values fall
  back to the fixed maximum, and equal timestamps use a stable path tie-break.
- Confirmed global byte accounting spans chats and registry kinds, while
  per-chat exact limits count terminal run IDs rather than individual files.
- Confirmed all new retention and deletion removal uses `PrivateStore`; no raw
  recursive remove or unlink was added to production paths.
- Confirmed a malformed/incomplete manifest cannot drive legacy-map inversion,
  an active migration backup is protected, and only an empty managed legacy
  backup is removed after chat deletion.
- Confirmed no Task 6 edit was needed in `private-store.ts`, `conversation.ts` or
  `tui.ts`: their existing protected removal, lazy SDK opening and confirmation
  primitives satisfy the new orchestration without duplicate paths.

## Commit

- Requested message: `fix: bind and retain chat-owned local state`

## Concerns

- The real Windows DACL integration test remains the one expected skipped test
  on this macOS host. Task 6 uses the already-tested cross-platform
  `PrivateStore` primitives, but no native Windows execution is claimed here.
- Terminal/active classification reads registered run logs during pruning; very
  large pre-retention stores therefore incur one linear startup scan before the
  configured byte ceiling is restored.
