# Task 11A — Shared command catalog and generated command docs

## Scope and baseline

- Requested baseline: `8451fab` (`fix: close final runtime review boundaries`).
- Owned production/docs files: `src/command-catalog.ts`, `src/commands.ts`,
  `scripts/render-command-docs.ts`, and `README.md`.
- Owned tests: `tests/commands-catalog.test.ts` and the narrow help/alias
  integration case in `tests/commands.test.ts`.
- Package metadata, the CLI entrypoint, changelog, and installer remain in the
  root Task-11 release slice.

## Fail-first evidence

Before production edits:

- `node --import tsx --test tests/commands-catalog.test.ts`
- 13 tests reached, 11 passed, 2 failed.
- The catalog invariant failed because `COMMAND_CATALOG`/its resolver did not
  exist. The documentation gate failed because
  `scripts/render-command-docs.ts` did not exist.

## Implemented contract

- `COMMAND_CATALOG` is the one flat top-level catalog. Every canonical command
  has one unique `handlerId`; canonical names and aliases share one validated,
  case-insensitive token index.
- `resolveSlashCommand(input)` accepts a token or whole slash input and returns
  the canonical command, handler ID, and normalized token. `SLASH_COMMANDS`
  remains a compatibility alias for the existing completion APIs.
- `handleSlashCommand` resolves through the catalog before its exhaustive
  handler switch, so aliases no longer have independent dispatch cases.
- `/help` renders the same catalog used by completion and dispatch.
- `scripts/render-command-docs.ts` deterministically renders the README table,
  supports `--check`, and fails if its owned markers are absent or stale.
- The generated README table now includes `/panel`, `/resume`, `/ssh`,
  `/chat ... delete`, and the truthful `ORCODE.md` `/init` target.

## Verification

- `node --import tsx --test tests/commands-catalog.test.ts tests/commands.test.ts`
  — 54 passed, 0 failed, 0 skipped.
- `npx tsc -p tsconfig.json --noEmit` — exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit` — exit 0.
- `node --import tsx scripts/render-command-docs.ts --check` — exit 0,
  `README command docs are current.`

## Boundary note

The catalog intentionally remains flat. Contextual compressor suggestions stay
in the existing completion helper; this slice does not introduce the recursive
0.5 command architecture.
