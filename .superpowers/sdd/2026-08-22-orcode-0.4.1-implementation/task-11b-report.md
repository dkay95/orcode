# Task 11b Report — Package and installer surfaces

## Scope

- Package metadata and lockfile root metadata now identify `orcode` 0.4.1 and
  expose both `orcode` and the backwards-compatible `routercode` binary at the
  same compiled entrypoint.
- The published allowlist includes the changelog and both public package
  scripts. `install:user` runs directly against the already-built `dist`
  shipped in the package rather than advertising an unavailable packaged
  source build.
- The user installer is import-safe and exposes injected filesystem/home/root
  seams. It preflights both alias paths before `mkdir`, `chmod`, or `symlink`,
  accepts only links to its exact own target, is idempotent, and never replaces
  a foreign file or link.
- `scripts/check-package.mjs` removes generated `dist`, performs a fresh build,
  derives the exact three TypeScript outputs per source file, compares the
  tarball byte-for-byte by path against the public allowlist, installs the real
  tgz into a temporary prefix, and invokes both npm bin shims with `--version`
  and `--help`. Every temporary pack/install path is removed in `finally`.
- `CHANGELOG.md` records the 0.4.1 foundation release without claiming a tag or
  registry publication.

## RED evidence

- Release metadata test failed on the existing package version (`0.4.0` versus
  `0.4.1`) before package or lockfile edits.
- Import-safety test showed the old installer executing immediately on import,
  creating the `routercode` link and exporting no injected API.
- Dual-alias/preflight tests showed no `orcode` inspection/link and recorded
  `mkdir` plus `chmod` before a conflicting `routercode` path was rejected.
- The deterministic allowlist test failed with `ERR_MODULE_NOT_FOUND` before
  `scripts/check-package.mjs` existed.

## GREEN evidence

- `node --import tsx --test tests/cli-entrypoint.test.ts`: 10/10 passed.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`:
  lockfile accepted and normalized by npm.
- `node --check scripts/install-user.mjs` and
  `node --check scripts/check-package.mjs`: exit 0.
- Real-filesystem installer smoke: both aliases created as links to the exact
  compiled CLI, a second run was idempotent, temporary home removed.
- `node scripts/check-package.mjs`: fresh build succeeded; exact 148-file
  tarball accepted; a real temporary-prefix tgz install ran `orcode --version`,
  `routercode --version`, `orcode --help`, and `routercode --help`; temporary
  pack/install data was removed.
- `git diff --check`: clean.

## Limits

- The real installer and tarball smoke ran on macOS with Node 22/npm 10. Native
  Windows execution remains Task 12's CI gate; this slice covers `.cmd` shim
  selection deterministically but does not claim a Windows runtime result.
- No npm registry publication, release tag, live provider call, or user-home
  installation was performed.
- Command catalog, runtime help/banner, generated README, and workflows are
  owned by the adjacent Task 11a/Task 12 slices and are intentionally outside
  this commit.

## Review Fix R1 — recover partial alias creation

The package review found one transactional gap after the original commit: if
`orcode` was created successfully and creating `routercode` then failed, the
first new link remained even though installation reported failure.

### RED

- An injected second-`symlink` failure left the newly created `orcode` alias in
  the fake filesystem instead of restoring the pre-call state.
- A timing fixture replaced that just-created link with an unrelated regular
  file before failure. The old implementation surfaced only the original
  error, with no indication that safe rollback was impossible.

### Fix

- Alias creation is now a transaction over only the missing aliases from the
  completed all-target preflight. Newly created links are recorded with their
  post-create file identity and removed in reverse order on failure.
- Rollback rechecks link type, exact resolved target, and captured file identity
  before `unlink`. A missing link is already restored; a replaced/foreign path
  is never removed. Any rollback error is combined with the original install
  error so the unsafe partial state cannot be hidden.
- Pre-existing correct aliases are never added to the rollback set. Success
  messages are emitted only after every required alias has been created.
- `mkdir` and executable `chmod` are intentionally not rolled back. The bin
  directory may have gained concurrent user content, making directory removal
  unsafe, while `dist/cli.js` is the installer-owned executable and mode `0755`
  is its required steady state. The binding invariant is exact restoration of
  the two alias paths.

### GREEN

- Focused rollback matrix: 2/2 passed, covering exact restoration,
  pre-existing-link preservation, unrelated-path preservation, and explicit
  unsafe-rollback reporting.
- Complete CLI-entrypoint/installer suite: 12/12 passed; production and test
  TypeScript checks and installer syntax check exited 0.
- A real-filesystem injected second-alias failure removed the first new link,
  left both alias paths absent as before the call, and removed its temporary
  home afterward.
- The fresh 148-file tarball check and both installed npm bin shims remained
  green; `git diff --check` remained clean.
