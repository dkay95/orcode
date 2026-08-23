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

## Review fixes — retryable partial alias installation

The first package review correctly identified that a second-link failure left
the first new alias behind without explaining recovery. Fix R1 attempted to
restore all-or-none behavior with `lstat`/`readlink` identity checks followed by
`unlink`. A follow-up timing probe swapped a foreign path after the final check
but inside the injected unlink boundary; path-based Node APIs could then delete
that unrelated path. R1's destructive rollback claim was therefore rejected
and is fully superseded here.

### Final RED contract

- Against R1, an injected second-`symlink` failure did not retain the first
  exact own link and did not report a safely retryable partial installation.
- A foreign replacement during that failure had to remain present with no
  `unlink` attempt. Path identity checks cannot make a later path deletion
  atomic, so any destructive rollback was disallowed by contract.
- A second invocation had to recognize the retained exact own first link and
  create only the still-missing second link.

### Final implementation

- The installer never deletes or replaces an alias. It retains its completed
  all-target preflight and creates only missing paths with `symlink`, whose
  no-overwrite behavior closes a concurrent-creation conflict safely.
- If a later alias fails after an earlier alias was created, the error states
  that installation is partial, that no path was deleted/replaced, and that it
  is safe to run the installer again. The original error remains the cause.
- On retry, an exact existing own link is accepted and only the missing alias is
  created. A file, wrong link, or concurrently replaced path is left untouched
  and rejected by the next preflight before mutation.
- Success messages remain deferred until every required alias exists. The
  package-owned executable's required `0755` mode and a possibly newly created
  bin directory remain benign setup state, as explicitly accepted in review;
  neither requires destructive cleanup.

### Final GREEN

- Focused partial-install/retry matrix: 2/2 passed, covering retained own-link
  retry, no second creation of the first link, foreign-path preservation, zero
  unlink attempts, and explicit partial-install guidance.
- Complete CLI-entrypoint/installer suite: 12/12 passed; production and test
  TypeScript checks and installer syntax check exited 0.
- A real-filesystem second-alias failure retained the first link and its inode;
  the next invocation created only the missing alias and temporary state was
  removed afterward.
- The fresh exact 148-file tarball check and both installed npm bin shims
  remained green; `git diff --check` remained clean.
