# Task 10 Slice B2 — Browser wiring and shared SSH operation state

## Scope and baseline

- Requested starting point: `c41fc16`.
- Before production edits, the independently approved Task-10-A follow-up was integrated as baseline `f75c4b0` (`fix: bind automatic git metadata to workspace`).
- Production files: `src/agent.ts`, `src/cli.ts`, `src/commands.ts`, `src/ssh.ts`, `src/workspace.ts`.
- Test files: `tests/agent.test.ts`, `tests/cli.test.ts`, `tests/ssh-command.test.ts`, `tests/ssh-slash-command.test.ts`, `tests/workspace.test.ts`.
- `tests/agent.test.ts` is the explicit minimal out-of-brief scope ruling needed to verify the Agent-to-Workspace boundary.
- B1 browser cleanup internals were not rewritten; `tests/browser.test.ts` was retained as the regression gate.

## Fail-first evidence

All tests below were run before their production changes.

1. Agent boundary RED:
   - `node --import tsx --test --test-name-pattern='agent binds browser config' tests/agent.test.ts`
   - 1 reached, 0 passed, 1 failed: the injected tool factory was never reached, proving browser config and shared SSH state were not wired through the agent.
2. Startup browser-prune RED:
   - Focused startup patterns in `tests/cli.test.ts`.
   - 3 reached, 0 passed, 3 failed: browser pruning was absent from post-migration ordering, best-effort invocation, and returned-error visibility.
3. Live SSH target RED:
   - Focused hostless/active patterns in `tests/ssh-command.test.ts`.
   - 4 reached, 1 passed, 3 failed: explicit host already won, but omitted host failed in Zod before active/missing/unknown runtime resolution.
4. Atomic `/ssh off` RED:
   - Focused off patterns in `tests/ssh-slash-command.test.ts`.
   - 2 reached, 0 passed, 2 failed: `active` stayed stale while close awaited and a close failure was swallowed.
5. Workspace browser-boundary RED:
   - Focused browser patterns in `tests/workspace.test.ts`.
   - 2 reached, 0 passed, 2 failed: the exact root signal was absent and a typed browser timeout emitted `timedOut:false`.
6. Self-review close-classification RED:
   - A realistic `spawn ssh ENOENT: no such file or directory` was misclassified as a harmless missing ControlMaster socket and reported success.

## Implemented contracts

### Browser

- `initializeStartupStorage` invokes `pruneBrowserTempArtifacts()` only after migration readiness and before config/session/key/network startup.
- Startup cleanup remains best effort and its thrown or returned per-path errors become visible retention warnings.
- `OrcodeAgent` reads the current config per run and passes `browserPath`, `browserTimeoutSeconds`, and the exact root `AbortSignal` into its coding-tool bundle.
- `browser_check` passes the exact signal to `inspectUrl` and emits a single terminal event with typed timeout state.
- B1 remains authoritative for exact owned-prefix, age-over-24h, ownership/type/symlink-safe startup pruning and fail-closed per-operation cleanup.

### SSH

- CLI creates one `SshSession` and passes that exact object to both runtime command surfaces and `OrcodeAgent`; the agent passes it to every run's Workspace tool bundle.
- `ssh_command.host` is optional. An explicit alias wins; otherwise the active alias is read from the live shared object when execution begins.
- Missing or unknown targets fail clearly before approval and before any SSH spawn. Approval subjects and execution use the resolved canonical alias.
- `/ssh off` sets `active = null` before awaiting ControlMaster close and never writes it after the await, so a newer concurrent selection survives.
- Missing control sockets remain benign. Launch, transport, timeout, and other real close failures remain non-fatal but are shown to the user after the active target is disabled.

## Final verification

- Combined scoped gate:
  - `node --import tsx --test tests/browser.test.ts tests/workspace.test.ts tests/agent.test.ts tests/ssh.test.ts tests/ssh-command.test.ts tests/ssh-slash-command.test.ts tests/cli.test.ts tests/commands.test.ts`
  - 308 passed, 0 failed, 0 cancelled, 0 skipped.
- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- `git diff --check`: exit 0 before staging.
