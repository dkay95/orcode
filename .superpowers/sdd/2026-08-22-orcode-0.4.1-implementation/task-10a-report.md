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

## Independent Review Fix Round 1

The post-commit review found two additional repository-delegation paths. The
new exact matrix was RED with 9 reached, 0 passed: a PATH entry located in the
workspace could be a symlink to an outside fake `git`, and symlinked
`HEAD`/`index`/`objects`/`refs`/`packed-refs` plus object alternates reached the
spawn boundary.

The fix checks both the lexical and canonical workspace names before
realpathing any executable candidate. Critical Git metadata is now recursively
snapshotted as regular file/directory identities, rejects every symlink and
`objects/info/{alternates,http-alternates}`, and is fully compared again after
approval immediately before spawn. The exact review matrix is GREEN 9/9 and
the complete workspace suite is GREEN 93/93; source TypeScript and diff-check
are also green. Test TypeScript/full-suite output was intentionally deferred
until the parallel B2 test-only RED fixtures receive their production wiring.

## Independent Review Fix Round 2

The first re-review found one remaining observer window: the final repository
snapshot happened before `runObservedProcess` synchronously emitted its visible
start event. A process-start consumer could therefore replace `.git/index` and
`.git/objects` after validation but before the runner was invoked. The exact
real-repository regression was RED 0/1 (`Missing expected rejection`) and the
fake runner received the swapped repository.

The root and executable identity checks plus the final complete repository
snapshot now execute inside the observed-process closure: after the visible
start event and immediately before invoking the runner, with no intervening
consumer callback. The named regression is GREEN 1/1; the complete independent
review matrix is GREEN 11/11 and `tests/workspace.test.ts` is GREEN 94/94.
Source TypeScript and the scoped diff-check are also green. The documented
same-user check-to-spawn kernel gap remains a native-launcher limitation; this
round closes the avoidable application callback window.

## Independent Review Fix Round 3

The second re-review found one remaining executable-selection alias: an outside
PATH name could point into the workspace and a later workspace symlink could
point back out to an outside fake `git`. Checking only the lexical candidate
and its final realpath missed that enter-then-leave traversal. The real launcher
regression was RED 0/1 and proved the outside marker executable ran.

Automatic Git selection now canonicalizes every existing prefix in each
candidate path and rejects the candidate if any prefix enters the canonical
workspace. Uninspectable prefix chains also fail closed so selection may try a
later trusted PATH entry. The exact alias regression is GREEN 1/1 and the
combined PATH/metadata/process-start security selection is GREEN 11/11.

## Independent Review Fix Round 4

The third review showed that prefix `realpath()` still collapsed a complete
symlink chain and could hide a workspace-owned intermediate target. The new
fixture links an outside PATH alias to `workspace/linked-bin`, which itself
links back to an outside fake executable. It was RED 0/1 and executed the fake
launcher.

Candidate inspection now walks path components and each `readlink()` target
itself, tracks at most 64 symlink hops, rejects every intermediate name or
target inside the canonical workspace, and rechecks the symlink identity after
reading it. Unresolvable or changing chains fail closed. The chained-alias test
is GREEN 1/1; the full PATH/metadata/process-start selection is GREEN 12/12 and
source TypeScript remains green.

## Independent Review Fix Round 5

The fourth review found that the component walker still normalized a raw link
target before walking it. That differs from kernel path semantics when `..`
appears after an intermediate symlink. The exact chained fixture was RED 0/1
and again reached the outside marker executable.

Raw `readlink()` targets now remain unnormalized. Their `.` and `..` components
are consumed one at a time against the already-resolved prefix, so every
intermediate symlink is inspected before later parent traversal is applied.
The exact dotdot chain is GREEN 1/1; the accumulated executable/metadata/start
matrix is GREEN 13/13 and source TypeScript remains green.

The final independent re-review is APPROVED with no remaining P0/P1 in this
boundary. The complete workspace suite is GREEN 97/97 and the scoped
diff-check is clean on the final code.
