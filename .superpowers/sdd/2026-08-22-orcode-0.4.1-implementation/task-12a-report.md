# Task 12A Report — Release metadata validator

## Delivered boundary

- `scripts/check-release-metadata.mjs` is import-safe and exposes a pure
  `assertReleaseMetadata` validator plus an injected `checkReleaseMetadata`
  orchestration seam.
- The validator requires canonical stable SemVer and an exact `v<version>` tag
  supplied through `--tag` or `ORCODE_RELEASE_TAG`. Missing, malformed,
  conflicting, stale, future, path-like, duplicate, and unexpected inputs fail
  closed.
- `package.json`, the package-lock top level, and the package-lock root package
  must agree on `orcode`, the version, and the exact `orcode`/`routercode`
  `dist/cli.js` bin mappings. Traversal or additional bin entries are rejected.
- The changelog must contain exactly one released version header with a real,
  non-future calendar date.
- The gate refuses a missing, non-regular, symlinked, or escaped built
  `dist/cli.js`. Windows path casing is normalized without broadening the
  containment check. File identity and SHA-256 are captured from a stable read
  and rechecked after `--version`, after `--help`, and after module import, so a
  concurrent rebuild or replacement cannot silently mix release evidence.
- The real built CLI is executed with Node for `--version` and `--help`, then
  imported side-effect-free. Its `renderCliBanner` and `renderCliHelp` exports
  must agree with package metadata and the process output.
- The script only reads local release artifacts and starts the local built CLI.
  It performs no network request, publication, tag creation, or repository
  mutation.

## TDD evidence

- Initial RED: all 9 initial focused tests failed because
  `scripts/check-release-metadata.mjs` did not exist.
- Initial GREEN: 9/9 focused tests passed after the minimal validator and
  orchestration implementation.
- Windows realpath-casing regression RED: 9/10 passed; the new case failed with
  `Unsicherer Build-Pfad abgelehnt` before platform-aware comparison existed.
- Independent review found one P1: the first implementation checked the CLI
  path only before its three consumers, leaving a replacement window.
- Review regression RED: 10/11 passed; replacing `dist/cli.js` after
  `--version` was not detected.
- Final focused GREEN after identity/SHA-256 binding: 11/11 passed.
- Independent re-review: APPROVED; the prior P1 is closed and no new P0/P1 was
  found.

## Fresh verification

- `node --import tsx --test tests/release-metadata.test.ts`: 11 passed, 0
  failed.
- `npx tsc --noEmit`: exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- `node --check scripts/check-release-metadata.mjs`: exit 0.
- `git diff --check`: exit 0.
- `npm run build && node scripts/check-release-metadata.mjs --tag v0.4.1`:
  fresh build succeeded and the real CLI/package/lock/changelog surfaces agreed
  on `orcode@0.4.1` and `v0.4.1`.

## Scope handoff

Task 12 still needs its parent integration to add package scripts/package
allowlisting and CI/release workflow wiring. This slice intentionally did not
edit `package.json`, either workflow, README, CHANGELOG, or the existing package
checker. Concurrent Task-12 files in the shared worktree were excluded from this
slice and its commit.
