# Task 5 report

## Status

DONE

## Documented scope expansion before edits

- `src/commands.ts`: the Task 5 self-review found that the dashboard propagated
  the migration-selected `appHome`, while the existing `/chat` list, new, open,
  search, and delete paths still fell back to `~/.orcode`. The parent approved
  the smallest scope expansion: pass `context.session.appHome` at those existing
  `SessionStore` call sites, with no command-semantics change.
- `tests/integration.test.ts`: the approved focused integration regression proves
  `/chat new` retains the home selected by startup migration. It uses the existing
  isolated harness and does not touch the real app home.

## Evidence

### RED

- Required focused command:
  `node --import tsx --test tests/app-home-migration.test.ts tests/private-store.test.ts tests/config.test.ts tests/session.test.ts tests/cli.test.ts`
- Exit: 1 before production edits; 78 tests reached, 63 passed and 15 failed.
- Expected failing behavior:
  - central artifact registry was absent;
  - legacy-only and deterministic dual-home migration were incomplete;
  - staged crash resume, corrupt artifact isolation, future-schema refusal,
    backup ceiling, and unavailable-boundary refusal were absent;
  - new-only config upgrade and startup ordering were absent;
  - config v0/current handling and future-version write refusal were absent;
  - POSIX/Windows/fail-closed `PrivateStore` behavior was absent;
  - `SessionStore` had no central registry path.
- Additional focused RED cycles before their production edits:
  - Windows DACL adapter: 1 reached, 0 passed; duplicate availability probe
    produced 4 runner calls instead of the required 3.
  - config normalization: migrated invalid `approvalMode` remained `unsafe`
    instead of validated `ask`.
  - dual-home authoritative config: target v0 config remained unversioned.
  - future migration manifest: version 99 was overwritten instead of refused.
  - legacy v1 rule migration: destination `permissions.json` was absent.
  - reserved task sidecars: hypothetical `tasks/.../future.json` was incorrectly
    migrated even though no 0.4 producer exists.
  - `/chat` app-home propagation: the replacement session used the real
    `~/.orcode` instead of the migration-selected test home.

### GREEN

- Required focused command: 80/80 passed, 0 failed.
- Production TypeScript: `npx tsc -p tsconfig.json --noEmit` passed.
- Test TypeScript: `npx tsc -p tsconfig.tests.json --noEmit` passed.
- Related migration/storage/config/session/CLI/run-log/conversation/workspace/
  rules/resume/agent/integration suites: 249/249 passed, 0 failed.
- Full regression: `npm test` passed, 661/661 tests, 0 failed.
- Central credential-fixture audit:
  `rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' 'sk-or-|AKIA|glpat-|npm_' tests README.md`
  returned no matches.
- `git diff --check` passed.

## Implementation

- Added `PrivateStore`, with atomic publish only after its private boundary is
  established. POSIX directories/files are 0700/0600. The deterministic Windows
  adapter constructs and verifies a protected DACL containing only the current
  user SID and SYSTEM, and exact writes fail closed with a visible error.
- Added the central `ChatArtifactRegistry` for every actual 0.4 chat artifact,
  with privacy, retention, migration, and deletion metadata. Task sidecars remain
  a reserved schema kind with no claimed producer or migration path.
- Routed `ConversationStore` main/conflict SDK state and `ChangeJournal`
  checkpoint reads/writes through `PrivateStore`. Redacted chat and run-log paths
  now resolve through the registry; rules also use the private atomic boundary.
- Replaced the one-step home rename with a versioned, persistent migration:
  source checksum, same-filesystem staging, destination list, stable chat-ID map,
  validation, atomic destination replacement, managed exact backup, phase and
  completion markers, resumable fault phases, and future-version refusal.
- Dual-home merge keeps new config authoritative, upgrades validated v0 config,
  merges current exact rules by fingerprint, upgrades safe v1 rules narrowly,
  retains unsafe v1 matches only as disabled records, imports legacy chats under
  stable new IDs, and uses that mapping for SDK state, runs, and checkpoints.
- Human-readable migrated chats and run logs pass through central redaction.
  Bare compatible NDJSON events become one current envelope per event without
  changing event order, timestamps, costs, or terminal outcome. Corrupt chats
  and runs are isolated and reported; lock files are never migrated.
- Added one startup initializer that awaits migration before config, rules,
  chats, checkpoints, SDK state, keys, or network can open. The returned
  `appHome` is explicitly propagated through CLI dashboard and slash-command
  chat/config operations.

## Self-review

- Confirmed a backup-over-limit or unavailable private boundary returns before
  creating the destination home, manifest, staging files, or backup.
- Confirmed manifest, staging, committed destinations, config rewrite backup,
  and renamed legacy backup use `PrivateStore`; the legacy tree is protected
  recursively after its atomic rename and symbolic links fail closed.
- Confirmed the persisted map is reused across restart and every actual 0.4
  chat sidecar; the reserved task kind is registry-only.
- Confirmed new config wins in dual-home migration and is normalized through the
  same config validator. Unknown future config and manifest versions are not
  overwritten.
- Confirmed migration code has no credential-store, key prompt, OpenRouter, or
  other network dependency. Startup ordering is enforced by the single awaited
  initializer and exercised with a blocked migration gate.
- Confirmed all newly added secret-like fixtures use deterministic string
  construction; the central literal audit remains empty.

## Commit

- Requested message: `fix: migrate local state through a private store`

## Concerns

- Windows ACL behavior is covered by deterministic process-adapter tests on the
  current macOS host; a real Windows DACL integration run was not available in
  this task. The adapter verifies the effective ACL after every protection call
  and fails closed on any mismatch.

## Fix Round 1

### Receiving-review verification

- Read the complete round-1 findings and updated implementation ledger, then
  reproduced every finding against base
  `4b4a1b8c693288fb27a4e0578494a58d9e1a00b5` before changing production code.
- All nine findings were confirmed. There was no technical pushback and no
  scope expansion beyond the Task 5 production/test files already authorized.
- Combined test-only RED command:
  `node --import tsx --test tests/private-store.test.ts tests/app-home-migration.test.ts tests/cli.test.ts tests/integration.test.ts tests/session.test.ts`.
  It reached 94 tests: 77 passed, 16 failed, and the registered Windows-only
  real-DACL test was skipped on macOS.

### RED evidence by finding

1. `Windows ACL invocation binds an untrusted path as data through an encoded
   parser boundary` failed because the adapter still used `-Command` and placed
   the path after the script instead of binding it as data. The real Windows
   integration was registered separately and skipped on this non-Windows host.
2. The named root/ancestor, swap-before-content, and `protectTree` symlink tests
   all failed: roots and ancestors were followed and the exact-write path had no
   pre-content identity recheck.
3. `declined future or recovery-required migration stops startup before any
   mutating store opens` failed because startup pruned/opened stores after an
   untyped declined migration result.
4. `dual-home rule merge applies deny precedence only within workspace tool and
   subject scope` failed because fingerprint-only identity discarded a deny and
   unrelated scoped rules.
5. The selected-home startup-path test and `/config` integration test failed:
   runtime config display/writes still fell back to the process-global path.
6. The invalid phase/path trap, source-checksum drift, and resumable completed
   cleanup tests failed because manifest fields/phases were trusted and cleanup
   was persisted before it completed.
7. Registry enumeration/lock classification and private chat-conflict coverage
   failed because `existing()` was an empty stub and the conflict writer used a
   raw rename. An additional legacy-only RED rerun proved chat-conflict sidecars
   were not migrated through the stable chat-ID mapping.
8. `migration isolates complete SDK state and checkpoint files rejected by
   production validators` failed because any parseable JSON was accepted.
9. `global backup ceiling preflights legacy config rewrite and existing managed
   backups before any write` failed after creating the migration manifest; only
   the renamed source size had been counted.

### Implementation and focused GREEN cycles

1. Windows protection now executes a UTF-16LE encoded PowerShell program and
   binds the untrusted path/kind through dedicated environment values. The path
   is absent from both script text and argv; DACL enforcement and verification
   remain current-user-plus-SYSTEM only and fail closed.
2. `PrivateStore` now has an explicit trusted root, rejects a symlink or
   non-directory in every component, verifies containment, snapshots ancestor
   identities, rechecks them and the exclusive temp-file identity before exact
   bytes are written and again before atomic publish, and rejects a symlink root
   in `protectTree()`.
3. Migration returns `ready`, `declined`, `future`, or `recovery-required`.
   Startup throws visibly for every non-ready status before pruning, config,
   rules, sessions, credentials, network, or another mutating writer can open.
4. Exact-rule identity now includes workspace, tool, and exact subject (or the
   disabled record ID). A deny replaces an allow only in the identical scope;
   unrelated rules remain intact.
5. Startup returns the config path derived from the selected app home. Plain and
   TUI runtime contexts propagate it, every affected config writer uses it, and
   `/config` displays it.
6. Manifest parsing is typed as absent/valid/invalid and validates schema,
   phase, checksum, canonical source/staging/backup roots, completion agreement,
   and destination containment before those fields drive filesystem work.
   Source checksums are revalidated before commit and rename; staging deletion
   finishes before the completion marker and is idempotently resumed.
7. The registry now classifies/enumerates chat transcripts, private chat
   conflicts, SDK state/conflicts, redacted run logs, checkpoints, and locks;
   locks are explicitly non-migrating and task sidecars remain reserved-only.
   Runtime and migration chat-conflict bytes use `PrivateStore` and the stable
   mapped chat ID.
8. Conversation-state and checkpoint parsers are now shared with their
   production readers. State validation includes SDK deserialization;
   checkpoint validation requires the complete array and matching run ID, so an
   invalid exact file is isolated whole.
9. Backup preflight now totals the renamed source, every existing managed
   backup, and any not-yet-present exact config-rewrite backup. Dual-home and
   config-only paths decline before manifest, staging, destination, or backup
   writes when that post-migration set exceeds the ceiling.

- Focused Windows binding cycle: 1/1 passed; Windows aggregate: 2 passed and 1
  real-integration skip.
- Focused symlink boundary cycle: all named root/ancestor/swap/tree tests passed.
- Focused startup-status and selected-config-path cycles passed.
- Focused rule-scope cycle: 1/1 passed.
- Focused manifest integrity/cleanup cycle: 3/3 passed.
- Focused registry/private-conflict cycle and the additional legacy-conflict
  migration rerun passed.
- Focused production-validator cycle: 1/1 passed; conversation/workspace
  regressions: 65/65 passed.
- Focused global-ceiling cycle: 1/1 passed.
- Combined post-fix command: 94 reached, 93 passed, 0 failed, 1 Windows skip.

### Final gates

- Required Task 5 focus from the brief
  (`app-home-migration`, `private-store`, `config`, `session`, `cli`): 94
  reached, 93 passed, 0 failed, 1 Windows-only skip.
- Related `runlog`, `conversation`, `workspace`, `rules`, `commands`, `agent`,
  and `integration` suites: 146/146 passed.
- `npx tsc -p tsconfig.json --noEmit`: passed.
- `npx tsc -p tsconfig.tests.json --noEmit`: passed.
- Full `npm test`: 676 reached, 675 passed, 0 failed, 1 Windows-only skip.
- Central credential-fixture audit
  (`rg -n --hidden --glob '!node_modules/**' --glob '!dist/**'
  'sk-or-|AKIA|glpat-|npm_' tests README.md`): no matches.
- `git diff --check`: passed.

### Round-1 self-review and concerns

- Rechecked startup ordering: migration is awaited before any store, keychain,
  key prompt, or network construction/access, and non-ready states cannot prune
  or create a chat.
- Rechecked all exact Task 5 writers: manifests, staging, config backups,
  renamed backup protection, rules, checkpoints/journals, SDK state/conflicts,
  and unredacted chat conflicts cross `PrivateStore`; redacted run-log paths are
  explicit registry paths. Locks are never migrated.
- Rechecked deterministic dual-home behavior: selected app home/config is
  propagated, new config remains authoritative, deny-wins is scoped, the
  persisted chat-ID map covers actual sidecars, and source checksums gate commit
  and rename.
- Rechecked migration dependencies: no credential-store, key prompt,
  OpenRouter, or network call exists in a migration path.
- The Windows-only real DACL integration test is registered but was not run on
  this macOS host. No actual Windows execution is claimed; cross-platform tests
  validate parser binding, exact argv/environment separation, DACL program
  contents, and fail-closed behavior.

## Fix Round 2

### Receiving-review verification and RED

- Read the complete round-2 findings and updated implementation ledger, then
  independently reproduced all three findings against base
  `990f6bfd1ddc88361ed52b907e201ad8d52aca53` before changing production code.
  All three were confirmed; there was no technical pushback or scope expansion.
- Initial combined behavioral RED command:
  `node --import tsx --test --test-name-pattern='Windows availability proves|rolls back a newly-created|ensureDirectory binds|protectTree binds|complete migration refuses' tests/private-store.test.ts tests/app-home-migration.test.ts`.
  It reached 5 tests: 0 passed and 5 failed.
- `Windows availability proves disposable directory and file DACL
  enforceability` failed because `available()` reported true after only the SID
  lookup even when a real file-DACL protection call returned exit 17.
- `PrivateStore rolls back a newly-created destination root when protection
  fails` failed because the root remained after the exact write was rejected.
- `PrivateStore ensureDirectory binds protection to the verified directory
  identity` and `PrivateStore protectTree binds protection and traversal to the
  verified tree identity` failed because a deterministic adapter-time swap
  changed the outside directory from 0755 to 0700.
- `complete migration refuses symlinked staging cleanup without touching
  outside` failed because recursive path-based cleanup deleted the outside
  victim through `.migration-staging -> outside`.
- Self-review added a distinct rename regression before restoring the safe
  primitive. `migration refuses a symlinked legacy source before rename and
  leaves its target untouched` reached 1 test: 0 passed and 1 failed because
  the raw rename moved the legacy symlink. This closed the test-observability
  gap between cleanup and rename.

### Implementation

1. Windows availability now creates a disposable directory and file and proves
   both DACL operations, including their post-write ACL verification, before a
   destination path can be created. Any probe failure returns unavailable and
   removes the disposable paths. `PrivateStore` separately tracks every
   directory it created and rolls those identities back in reverse order when
   directory or file protection fails.
2. POSIX protection uses the already-open file/directory handle for chmod.
   `ensureDirectory`, `protectTree`, and atomic writes snapshot file IDs, reject
   symlinks/non-regular nodes, and revalidate ancestor, named-path, and open-
   handle identity before and after every awaited protection/traversal boundary.
   A deterministic swap therefore protects only the originally opened inode,
   leaves outside content and metadata unchanged, and returns failure.
3. Recursive `rm` and raw migration-tree rename were removed from storage
   migration. `PrivateStore.removeTree()` performs a sorted, manual no-symlink
   walk with root/ancestor and open-handle identity checks around reads and
   deletes. `PrivateStore.renameTree()` verifies source and destination parents,
   requires a real source directory, binds its identity to an open handle where
   supported, and brackets the rename with source/destination identity checks.
   Cleanup/protection/rename mismatches are converted to typed
   `recovery-required` migration results.

### Focused GREEN and final gates

- Round-2 behavioral command, including the additional rename regression: 6/6
  passed, 0 failed. The outside directory/file modes and content stayed
  unchanged in both deterministic protection-swap tests, and the cleanup and
  rename targets survived their symlink traps.
- Required Task 5 focus (`app-home-migration`, `private-store`, `config`,
  `session`, `cli`): 100 reached, 99 passed, 0 failed, 1 Windows-only skip.
- Related `runlog`, `conversation`, `workspace`, `rules`, `commands`, `agent`,
  and `integration` suites: 146/146 passed.
- `npx tsc -p tsconfig.json --noEmit`: passed.
- `npx tsc -p tsconfig.tests.json --noEmit`: passed.
- Full `npm test`: 682 reached, 681 passed, 0 failed, 1 Windows-only skip.
- Central credential-fixture audit
  (`rg -n --hidden --glob '!node_modules/**' --glob '!dist/**'
  'sk-or-|AKIA|glpat-|npm_' tests README.md`): no matches.
- `git diff --check`: passed.

### Round-2 self-review and concerns

- Rechecked that the disposable Windows preflight happens before any migration
  destination mutation and that a later protection failure cannot leave a
  newly created root or exact temp file behind.
- Rechecked every new await boundary in directory creation, tree protection,
  recursive cleanup, atomic file publication, and legacy-tree rename. POSIX
  metadata protection is handle-bound; cleanup never follows a symlink; all
  path operations fail closed when their recorded file ID changes.
- The Windows-only real-DACL integration remains registered but skipped on this
  macOS host; this report does not claim an actual Windows run.
- Node exposes no public `openat`/`unlinkat`/`renameat` API here. The
  implementation is handle-bound where Node supports it and revalidates file
  IDs across every awaited boundary, but it does not claim kernel-atomic
  protection against an external native process racing inside one filesystem
  syscall. A native helper would be required to remove that final single-
  syscall boundary and is intentionally outside Task 5.

### Commit

- Requested message: `fix: bind private storage operations to verified roots`

## Fix Round 3

### Receiving-review verification and RED

- Read the complete round-3 findings and updated implementation ledger, then
  independently reproduced all three Critical findings against base
  `a6b2e3e2de6cacff3533f2cccdab1aaf59a7072c` before changing production code.
  All three findings were confirmed; there was no technical pushback and no
  scope expansion.
- Feasibility review confirmed that the Windows boundary can remain available
  without a weaker pathname ACL operation: `CreateFileW` can open the final
  file or directory without following a final reparse point,
  `GetFileInformationByHandle` exposes the identity represented by Node's
  Windows `dev`/`ino`, and `SetSecurityInfo` plus `GetSecurityInfo` operate on
  that same open handle.
- Initial combined behavioral RED command:
  `node --import tsx --test --test-name-pattern='Windows PrivateStore child refuses|temp cleanup never unlinks|pre-open snapshot' tests/private-store.test.ts tests/private-store-identity-races.test.ts`.
  It reached 5 tests: 0 passed and 5 failed.
- `Windows PrivateStore child refuses a swapped file ID before changing the
  outside DACL` failed because the old child changed the currently resolving
  outside directory to mode 0700 before JavaScript detected the swap.
- `PrivateStore temp cleanup never unlinks a replacement name after ancestor
  mismatch` failed because catch cleanup removed the outside same-basename
  sentinel through the swapped parent.
- The three `PrivateStore protect/remove/rename compares the pre-open snapshot
  ... replacement` tests failed because the opened replacement superseded the
  earlier snapshot: it was respectively chmoded, deleted, and moved.
- A focused self-review assertion then exposed an open-handle leak on the
  remove rejection path (`fd` remained 20 instead of closing to -1); the named
  remove test reached 0/1 before the compare was moved inside `try/finally`.
- A second in-scope self-review RED,
  `PrivateStore rename rechecks the opened source after awaited destination
  inspection`, reached 0/1 because a replacement introduced during the awaited
  destination check was still moved. It was added before the final source
  recheck was implemented.

### Implementation

1. The Windows DACL child now uses a C# Win32 interop boundary. It opens the
   final object once with `CreateFileW`, `FILE_FLAG_BACKUP_SEMANTICS`, and
   `FILE_FLAG_OPEN_REPARSE_POINT`; rejects a reparse point, kind mismatch, or
   unexpected volume/file ID before any effect; builds the protected two-ACE
   current-user-plus-SYSTEM full-control DACL; applies it with
   `SetSecurityInfo`; and reads and verifies the protected exact DACL with
   `GetSecurityInfo` on the same `SafeFileHandle`. There is no `Set-Acl` or
   `Get-Acl` path operation. A nonzero child result remains fail-closed.
2. All identity-sensitive Node snapshots now use bigint `dev`/`ino`. The
   expected identity is passed to the encoded child as decimal environment
   data, never interpolated into the program or argv. Windows directory
   operations retain a Node identity handle where the runtime can open one;
   failure to open fails before an effect.
3. Atomic-write cleanup records both the trusted ancestor chain and exclusive
   temp-file handle identity before protection. Catch cleanup revalidates the
   ancestors and the handle-to-name binding, revalidates ancestors again, and
   unlinks only that still-bound name. Any mismatch leaves the unknown current
   name untouched and closes the recorded handle.
4. Protect, file/directory remove, and tree rename compare the pre-open
   snapshot with the identity obtained from the opened handle before chmod,
   traversal/deletion, or rename. Handles remain open across awaited checks and
   close in `finally`; rename additionally rechecks the open source against its
   current name after awaited destination inspection and immediately before
   the filesystem operation.
5. Cross-platform deterministic swaps verify that every replacement and
   outside sentinel remains unchanged while the operation fails closed. The
   Windows static boundary test also requires both security calls to receive
   the same variable named `handle`, in addition to the Windows-only real
   integration test registered by the earlier round.

### Focused GREEN and final gates

- Round-3 behavioral command including the self-review rename regression: 6/6
  passed, 0 failed. The outside mode/content stayed unchanged in all swaps.
- Combined PrivateStore suites: 18 reached, 17 passed, 0 failed, 1 Windows-only
  skip.
- Required Task 5 focus plus the new identity-race suite
  (`app-home-migration`, `private-store`, `private-store-identity-races`,
  `config`, `session`, `cli`): 106 reached, 105 passed, 0 failed, 1
  Windows-only skip.
- Related `runlog`, `conversation`, `workspace`, `rules`, `commands`, `agent`,
  and `integration` suites: 146/146 passed.
- `npx tsc -p tsconfig.json --noEmit`: passed.
- `npx tsc -p tsconfig.tests.json --noEmit`: passed.
- Full `npm test`: 688 reached, 687 passed, 0 failed, 1 Windows-only skip.
- Central credential-fixture audit
  (`rg -n --hidden --glob '!node_modules/**' --glob '!dist/**'
  'sk-or-|AKIA|glpat-|npm_' tests README.md`): no matches (`rg` exit 1).
- `git diff --check`: passed.

### Round-3 self-review and concerns

- Rechecked that no Windows child pathname operation can change a DACL: the
  expected Node file ID is compared after the child opens the object and both
  the set and verification use that one handle. The existing disposable DACL
  preflight still runs before any migration destination mutation.
- Rechecked every temp-cleanup, protect, remove, and rename rejection path for
  outside survival and handle closure. A changed ancestor or name is treated as
  unknown and is never cleaned up by name.
- The Windows-only real-DACL integration remains registered but was skipped on
  this macOS host. The C#/PowerShell child was not compiled or executed on
  Windows during this round, so no actual Windows run is claimed; Windows CI is
  still required for that platform evidence.
- Node exposes no public `openat`/`unlinkat`/`renameat` API here. The code is
  handle-bound for permission changes and uses pre-open/opened file-ID equality
  plus repeated ancestor/name checks for cleanup and rename, but does not claim
  kernel-atomic protection from a native attacker racing inside the final
  unlink/rename syscall. Removing that accepted single-syscall boundary would
  require a native helper and remains outside Task 5.

### Commit

- Requested message: `fix: close private store identity races`

## Fix Round 4

### Receiving-review verification and RED

- Read the complete round-4 findings and updated implementation ledger, then
  independently verified both multi-await findings against base
  `c7b0f8b4a29f4491d0108b477d629b27a8f31c27` before changing production code.
  Both findings were confirmed; there was no technical pushback, blocker, or
  scope expansion.
- The temp-cleanup regression schedules the replacement during the second and
  final ancestor `lstat` await, after the old handle/name validation. The
  protection regressions arm only after the caller snapshot and swap during
  the exact helper ancestor await; `ensureDirectory` accounts for its one
  preceding caller-level ancestor await so it does not test another phase.
- Exact RED command:
  `node --import tsx --test --test-name-pattern='final ancestor await|caller snapshot through the helper ancestor await' tests/private-store-identity-races.test.ts`.
  It reached 3 tests: 0 passed and 3 failed.
- `PrivateStore temp cleanup checks the bound name after its final ancestor
  await` failed with `ENOENT` when reading the same-basename replacement: the
  old cleanup unlinked it after the swap.
- `PrivateStore protectTree keeps its caller snapshot through the helper
  ancestor await` and `PrivateStore ensureDirectory keeps its caller snapshot
  through the helper ancestor await` both observed the replacement directory
  changed from mode 0755 to 0700 before the later mismatch was accepted or
  rejected.

### Implementation

1. `unlinkBoundTemporary()` retains its early trusted-ancestor validation, but
   orders the final awaited boundary as ancestor identity, handle-to-name (or
   recorded path) identity, then immediate `unlink()`. A name installed during
   the final ancestor await is therefore compared with the still-open original
   handle and left untouched on mismatch.
2. `protectBoundPath()` now requires the caller's `PathIdentity`. It compares
   that expected identity with its post-ancestor-validation `lstat` snapshot,
   then the existing open-handle check compares the helper snapshot with the
   opened object before the adapter can chmod or apply a DACL.
3. `protectTree()` passes its original directory/file snapshot for roots and
   file children. `ensureOneDirectory()` passes the identity captured before
   its intervening ancestor awaits. A replacement can no longer become the
   helper's new baseline.

### Focused GREEN and final gates

- Round-4 race command: 3/3 passed, 0 failed; every replacement retained mode
  0755/file mode 0644 and sentinel content while the operation rejected.
- Combined PrivateStore suites: 21 reached, 20 passed, 0 failed, 1 Windows-only
  skip.
- Task 5 focus plus the identity-race suite (`app-home-migration`,
  `private-store`, `private-store-identity-races`, `config`, `session`, `cli`):
  109 reached, 108 passed, 0 failed, 1 Windows-only skip.
- Related `runlog`, `conversation`, `workspace`, `rules`, `commands`, `agent`,
  and `integration` suites: 146/146 passed.
- `npx tsc -p tsconfig.json --noEmit`: passed.
- `npx tsc -p tsconfig.tests.json --noEmit`: passed.
- Full `npm test`: 691 reached, 690 passed, 0 failed, 1 Windows-only skip.
- Central credential-fixture audit
  (`rg -n --hidden --glob '!node_modules/**' --glob '!dist/**'
  'sk-or-|AKIA|glpat-|npm_' tests README.md`): no matches (`rg` exit 1).
- `git diff --check`: passed.

### Round-4 self-review and concerns

- Rechecked that each new test mutates a real filesystem name during the
  specified await and asserts real replacement metadata/content rather than a
  mock call count. All deferred swap hooks were consumed in their intended
  phase.
- Rechecked the complete protection chain: caller snapshot, helper snapshot,
  and opened handle must all represent the same kind and file ID before POSIX
  chmod or the Windows adapter is invoked.
- This round did not change the Windows DACL child. Its real Windows-only test
  remains registered and skipped on this macOS host; no actual Windows run is
  claimed.
- The accepted native single-syscall race after the final identity check and
  inside `unlink` remains unchanged. Node still exposes no public bound
  `unlinkat` primitive here; removing that boundary requires the native helper
  already documented as outside Task 5.

### Commit

- Requested message: `fix: revalidate private paths at final await boundaries`
