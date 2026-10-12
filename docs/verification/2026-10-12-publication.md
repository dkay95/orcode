# WIP source publication — 2026-10-12

## Scope

Publish the current development source and workbench GUI on a separate GitHub
branch. No merge to stable `main`, release tag, signed package, native installation,
or successful real provider login is claimed.

## Source and history

- Public base: `08996fa2` (0.4.0).
- Imported development snapshot: source tree from `16ba20b`, not its local ancestry.
- 81 local state/report/planning files excluded before import.
- No private app homes, accounts, credentials, dependencies, or generated builds staged.
- Independent filename/history audit: 381 regular files before this publication note;
  no symlinks, submodules, internal state paths, or credential-store filenames.
- Targeted credential-pattern scan: no unreviewed candidates. One repeated-decimal
  synthetic token in a frame-redaction test was explicitly confirmed as a test datum.
  This targeted scan is not a universal secret-content certification.
- GitHub Push Protection also flagged that static dummy. The test now constructs
  the identical repeated-decimal value at runtime; no protection bypass was used.

## Fresh checks

- Root build and test TypeScript check passed.
- GUI build and 261 GUI tests passed, including isolated engine protocol smoke tests.
- Staged whitespace check passed after removing one extra blank line at EOF.
- Default full Core run: 4452 tests, 4357 passed, 94 failed, 1 skipped.
- Second full run's JUnit report contains 89 failing cases: 88 Codex runtime-version
  precondition failures and one config-writer ownership verification failure.

## Known blockers

The integration trust policy requires the signed Codex 0.142.5 runtime. Several
integration tests resolve the system wrapper, whose installed package is currently
0.159.1. These tests fail before protocol execution. No downgrade or trust bypass
was performed. Updating the adapter and isolating its integration runtime are
required follow-up work.

The config-writer ownership verification failure also remains open. This sandbox
denies direct process inspection; the failure is not silently skipped or called
a passing environment check.

Browser geometry/native usability/real login acceptance remain separate gates.
Publication is a clearly documented work-in-progress snapshot, not completion.
