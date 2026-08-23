# Task 11 Report — Catalog-driven release surfaces

Task 11 was implemented in three reviewable slices: the shared command
catalog/documentation, the package and installer boundary, and the dashboard
CLI integration recorded here.

## Delivered boundaries

- One flat `COMMAND_CATALOG` now owns canonical slash-command names, aliases,
  descriptions, usage, and handler IDs. Dispatch, completion, help, and the
  generated README table consume that catalog. Contextual compressor
  completion remains deliberately flat; recursive command architecture belongs
  to the later 0.5 core work.
- Dashboard pre-dispatch resolves exact catalog tokens once. Interactive image,
  voice, model, compressor, reasoning, approval, chat, key, reconnect, and
  balance surfaces use the canonical handler ID while preserving the original
  arguments, quoted paths, and raw command text for execution.
- CLI banner, `--version`, and help derive version `0.4.1` from package
  metadata. Help documents the implemented PowerShell flags, override
  precedence, macOS-only native image picker, and process-only environment-key
  behavior without claiming unsupported Windows interaction.
- Package metadata and lockfile agree on `orcode@0.4.1`. Both `orcode` and the
  compatibility alias `routercode` point to the same built entrypoint.
- The user installer preflights both aliases before mutation, is idempotent for
  correct links, and never deletes or overwrites an alias path. If the second
  alias fails, the already-created exact link remains and the visible error
  explains that rerunning safely completes only the missing alias.
- The package checker deletes stale build output, rebuilds, enforces an exact
  tarball allowlist, installs the real tarball into a temporary prefix, invokes
  both npm shims with `--version` and `--help`, and cleans its temporary data.

## Commits

- `3765a46` — generated command surfaces and catalog-driven dispatch/docs.
- `4008bf3` — package metadata, dual aliases, installer, tarball smoke, and
  changelog.
- `33fae37` — dashboard CLI integration, canonical alias handling, and the
  consolidated report.
- `9faf2ea` — corrected native Windows shell and image-picker documentation.
- `e9e25d7` — replaced destructive alias rollback with a non-destructive,
  retryable partial-install contract. The superseded intermediate rollback
  commit is retained in history but is not the final behavior.

## TDD and focused verification

- CLI exports and catalog resolution were first captured RED: package-derived
  banner/help/version helpers and exact dashboard alias resolution did not
  exist. The package version assertion remained RED at `0.4.0` until the
  package slice updated the single metadata source.
- Final combined Task-11 focus: 61/61 passed
  (`commands-catalog`, `cli-entrypoint`, and `cli`).
- Production and test TypeScript checks: exit 0.
- Generated README check: current.
- Package checker: fresh 148-file tarball, real temporary installation, both
  npm shims verified.

## External limits

- The real package/install smoke ran on macOS with Node 22/npm 10. Native
  Windows execution remains a Task-12 CI gate.
- No npm publish, Git tag, GitHub release, or user-home installation was
  performed.
- Task 11 intentionally delivers a flat catalog, not the recursive 0.5 command
  architecture.

## Holistic review closure

The first independent integrated review found two P1 boundaries:

1. Two stale README sections still claimed that Windows required `/bin/sh` and
   a POSIX shell. A fail-first documentation assertion captured the drift;
   `9faf2ea` now documents the exact native PowerShell invocation, override
   precedence, and image-picker platform boundary.
2. The first dual-alias implementation could leave a partial alias after an
   I/O failure. A first attempt rolled back a newly created path, but review
   correctly demonstrated the unavoidable `lstat`/`readlink` to `unlink`
   replacement window in Node. The final design never deletes an alias path:
   it reports a partial install, preserves the correct first alias, and a retry
   creates only the missing second alias. Foreign replacements remain untouched
   and are rejected by the next preflight.

Final fresh evidence on the reviewed implementation:

- Combined Task-11 focus: 61/61 passed.
- Production and test TypeScript checks: exit 0.
- README generation check and installer syntax check: current/valid.
- Fresh exact package: 148 files; real temporary install; both `orcode` and
  `routercode` passed `--version` and `--help`.
- Full suite: 994 passed, 0 failed, 1 existing platform-only skip (995 total).
- Central credential scanner and literal credential audit: no findings.
- `git diff --check` and tracked status: clean before this report update.
- Independent final Task-11 re-review: APPROVED, no remaining P0/P1.
