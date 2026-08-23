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
  correct links, and never overwrites a conflicting file or link.
- The package checker deletes stale build output, rebuilds, enforces an exact
  tarball allowlist, installs the real tarball into a temporary prefix, invokes
  both npm shims with `--version` and `--help`, and cleans its temporary data.

## Commits

- `3765a46` — generated command surfaces and catalog-driven dispatch/docs.
- `4008bf3` — package metadata, dual aliases, installer, tarball smoke, and
  changelog.
- The dashboard CLI integration and this consolidated report are committed as
  the final Task-11 slice.

## TDD and focused verification

- CLI exports and catalog resolution were first captured RED: package-derived
  banner/help/version helpers and exact dashboard alias resolution did not
  exist. The package version assertion remained RED at `0.4.0` until the
  package slice updated the single metadata source.
- Final combined Task-11 focus: 58/58 passed
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

Pending independent P0/P1 review of the integrated Task-11 commits and final
release gates. The result and any RED-to-GREEN closure will be appended before
Task 11 is marked complete.
