# Task 10 Slice A Report

Slice start base: `587943673f0347c3713acf2ab45946d232cbabf7`

## Scope

- Hardened only the central automatic Git read adapter in `src/workspace.ts`
  and its regressions in `tests/workspace.test.ts`; `src/rules.ts` and every
  non-Slice-A production path remain unchanged by this slice.
- Every model diff, direct `/diff`, dashboard status, and direct status read now
  uses the same adapter, exact approval tuple, and existing single observed
  process lifecycle.
- Concurrent Task-10 slice commits landed while this slice was being verified;
  the Slice-A diff and commit remain restricted to the two allowed code/test
  files plus this dedicated report.

## RED evidence

1. Initial focus before production edits:
   `node --import tsx --test --test-name-pattern='automatic Git|Git subject names' tests/workspace.test.ts`
   reached 10 selected leaves and failed all 10. The old boundary used `cat` as
   pager, forwarded a broad hostile environment, executed the repository-local
   first `git` from `PATH`, accepted filter/include launchers, discovered a
   parent repository, and retained a symlink spelling as its execution cwd.
2. Approval-window review probes before their production fix:
   `node --import tsx --test --test-name-pattern='approval-time|PATH directory named git' tests/workspace.test.ts`
   failed 3/3: workspace and executable replacements produced “Missing expected
   rejection”, while a PATH directory named `git` was selected and returned a
   null launch exit. The separate late-config probe failed 1/1 with “Missing
   expected rejection”.
3. Repository delegation probe, with the still-uncommitted guard removed before
   the production fix:
   `node --import tsx --test --test-name-pattern='commondir' tests/workspace.test.ts`
   failed 1/1 because Git would have spawned with externally delegated common
   metadata.
4. Minimal-environment audit:
   `node --import tsx --test --test-name-pattern='Git subject names' tests/workspace.test.ts`
   failed 1/1 until `GIT_NO_LAZY_FETCH=1` became part of the exact child
   environment.

## Implementation

- Resolves every `git` candidate before approval, canonicalizes it, requires a
  regular executable outside the canonical workspace, skips repository-local
  candidates, and executes exactly the approved absolute path. The executable
  identity is revalidated after approval.
- Canonicalizes and binds the workspace directory identity, forces explicit
  `--git-dir=.git` and `--work-tree=.`, rejects gitfiles/symlinked `.git` and
  `commondir`, and revalidates workspace/repository identity immediately before
  spawn. Parent repository discovery is therefore unavailable.
- Uses real `--no-pager`, `--no-ext-diff`, `--no-textconv`, ignored submodules,
  `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, disabled global/system config,
  disabled system/global attributes, and command-line overrides for pager,
  editor, AskPass, credential helper, hooks, fsmonitor, external diff, and
  protocol launch paths. No executable pager substitute is used.
- Builds a fixed minimal child environment rather than filtering and forwarding
  the host environment. Approval subject names are derived from that exact
  object, the same object reaches the runner unchanged, and no environment
  value enters the subject or remembered-rule fixture.
- Fails closed on arbitrary local filter sections and includes, which cannot be
  exhaustively overridden by name. Config and config.worktree are bounded,
  opened without symlink following on POSIX, checked against their open-handle
  identities, and rescanned after approval. No separate preflight process was
  introduced.

## GREEN evidence

- Final Git focus:
  `node --import tsx --test --test-name-pattern='automatic Git|Git subject names|automatic diff' tests/workspace.test.ts`
  passed 16/16.
- Complete workspace suite: `node --import tsx --test tests/workspace.test.ts`
  passed 84/84.
- Approval/rules/workspace/Task-8 process/Task-9 verification/TUI/RunLog/command
  focus passed 374/374.
- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- `npm test`: 919 passed, 0 failed, 1 existing platform skip (920 total).
- Central credential scanner: exit 0 with no findings. Literal `sk-or-`,
  `AKIA`, `glpat-`, and `npm_` audit: expected `rg` exit 1 with empty output.
- Source audit found no direct Git spawn outside the central adapter.
- `git diff --check` passed for the Slice-A files.

## Concerns and limits

- Repositories with local filter/include sections, linked-worktree gitfiles, or
  `commondir` deliberately fail closed instead of showing a potentially unsafe
  status/diff. This trades compatibility for the required no-launch boundary.
- Approval-time replacement attacks are deterministically covered and config
  reads are handle-bound. As with any JavaScript `spawn(path)` boundary, a
  same-user attacker still has the final kernel gap between the last identity
  check and the spawn syscall; eliminating that remaining syscall window would
  require a native descriptor-bound launcher or OS sandbox.
- Real launcher/marker tests ran on macOS and their POSIX fixtures skip Windows.
  Existing deterministic Windows PATH/PATHEXT and environment construction
  coverage remains green; no native Windows process result is claimed.

Requested commit: `fix: harden automatic git processes`
