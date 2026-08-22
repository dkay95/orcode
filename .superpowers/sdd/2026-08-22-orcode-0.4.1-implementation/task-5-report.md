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
