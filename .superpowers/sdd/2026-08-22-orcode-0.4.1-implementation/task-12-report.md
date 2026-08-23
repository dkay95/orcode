# Task 12 Report — Release and cross-platform gates

## Delivered release boundary

- CI now verifies the minimum Node 22 runtime on Ubuntu, macOS, and Windows,
  plus a Linux Node 24 lane for metadata, migration, release-regression, real
  POSIX-PTY, package, audit, and clean-tree gates.
- `scripts/check-package.mjs` fresh-builds the project and compares
  `npm pack --dry-run --json` with a real pack by filename, integrity, shasum,
  packed/unpacked size, entry count, and every file's path, size, and mode. The
  real tarball is hash-checked, installed twice in isolated homes, scanned from
  the authoritative installed bytes, and exercised through both npm bin shims.
- Package children receive an allowlisted environment with isolated npm, home,
  app-data, and XDG paths. Credential variables, npm configuration inherited
  from the caller, and `NODE_OPTIONS` do not cross that boundary.
- Publishable text is checked by the central credential scanner and by
  normalized checkout/private-home path detection, including file URLs,
  slash-normalized Windows paths, JSON-escaped paths, and bare home roots.
- `--output` emits only the exact verified tgz, its SHA-512 checksum, and a
  release manifest into a new project-local directory. That is the artifact
  handed from the unprivileged verification job to publication.
- Release metadata is bound to the exact `dkay95/orcode` repository, package,
  lockfile, changelog, requested tag, and a stable identity plus SHA-256 of the
  built CLI across `--version`, `--help`, and import.
- A committed sanitized v0 app-home fixture exercises the real startup
  migration, exact backup bytes, current schemas, ID mapping, idempotent second
  startup, and zero network/credential-store calls.
- The release smoke uses a real POSIX PTY against built code. It proves TTY
  input/output, the 100x28 viewport, one bracketed multiline paste that waits
  for a later Enter, and terminal cleanup on exit. It makes no ConPTY claim.

## Privileged publishing design

- Publication is manual only; creating or pushing a tag never publishes.
- The verification job has no environment and no `id-token: write`. It checks
  out the exact selected tag without persisted credentials, performs every
  build/test/package gate, and uploads only the inspected release directory.
- The publish job is the sole OIDC-capable job. It has no checkout, dependency
  install, cache, or repository script execution. Its pinned official actions
  only install the exact Node 24.17.0 runtime and download the verified artifact.
- Both jobs require a protected `github.ref` equal to `refs/tags/<input>` and a
  `github.workflow_ref` for the same tag. Checkout uses the immutable dispatch
  event SHA and verifies `HEAD == GITHUB_SHA`, so a later tag movement cannot
  mix built bytes with provenance for another commit.
- The publish job independently rechecks the artifact hash and extracts only
  `package/package.json` with system `tar`. It requires internal
  `orcode@<tag>`, the exact `dkay95/orcode` repository, an absent-or-false
  `private` flag, exactly the `orcode` and `routercode` bin aliases, and no
  install/prepare lifecycle scripts before publishing the tgz.
- Node 24.17.0 and its bundled npm 11.13.0 are asserted exactly. No npm token or
  repository secret is referenced; Trusted Publishing supplies short-lived OIDC
  authentication and automatic provenance after external setup.

## RED and review evidence

- Initial workflow/package tests lacked the four-platform matrix, release
  scripts, dry-run/real equivalence, migration fixture, PTY smoke, manual OIDC
  split, and honest first-publication documentation.
- Adversarial package probes reproduced private-path bypasses for file URLs,
  Windows/escaped forms, and bare home roots; inherited npm/Node controls also
  reached child npm processes. The new scanner/environment regressions close
  those cases.
- Dry-run and real pack results previously compared only paths. A regression now
  rejects changed integrity or size despite an identical inventory.
- The first release workflow granted OIDC authority to installs and repository
  tests. Review required a no-OIDC verify job and a minimal artifact-only publish
  job with commit-pinned actions.
- A main-branch dispatch would have produced provenance for the wrong Git ref.
  The workflow now binds dispatch ref, workflow-definition ref, input tag, and
  protected tag; documentation uses `gh workflow run --ref "$TAG"` rather than
  claiming an unverified web-UI tag selector.
- Review then reproduced a retag window between dispatch and a tag-name
  checkout. The final checkout uses the immutable event SHA and asserts its
  identity before any npm step; release-tag updates and deletion are disallowed
  by a separate documented no-bypass ruleset, distinct from the owner-only tag
  creation ruleset.
- The first privileged validator trusted the outer tgz filename. A named RED
  showed no internal `package/package.json` check; npm 11.13.0 identifies a
  renamed tarball by its internal name/version. The final validator accepts the
  real artifact and rejects a freshly re-hashed outer `0.4.1` artifact whose
  internal version was changed to `0.4.2`.
- Final fail-first regressions rejected a foreign package repository and the
  impossible claim that one ruleset could grant tag creation to the owner while
  denying that same bypass actor update/delete authority. Repository identity
  is now checked at metadata, package, and privileged publish boundaries; tag
  creation and immutability use two separate documented rulesets.

## Fresh verification

- Metadata/workflow/package-entry focus: 27/27 passed and the real built CLI
  agreed with `v0.4.1`.
- Historical migration/private-store gate: 42 passed, 0 failed, 1 native
  Windows-only skip on this macOS host.
- Release regression selection: 340/340 passed.
- Real POSIX PTY smoke: passed with the expected paste and terminal-cleanup
  evidence.
- `npm run check:package`: exact 148-file tarball; both installed bin shims
  passed `--version` and `--help`.
- Artifact-output validator: real artifact accepted; matching-manifest/internal
  version-mismatch artifact rejected.
- `npm publish <tgz> --dry-run --access public --json`: identified
  `orcode@0.4.1` and did not execute package lifecycle scripts.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- Full source/test gate: 1,014 passed, 0 failed, and 1 expected native-Windows
  platform skip (1,015 reached); both TypeScript configurations passed.
- Central credential scanner and literal credential-fixture audit: no findings.
- Workflow YAML parse, script syntax, generated README check, and
  `git diff --check`: passed.
- Independent final review: APPROVED with no remaining P0/P1.

## External prerequisites and limits

- No tag, GitHub environment/ruleset, npm package, Trusted Publisher, or registry
  release was created in this task.
- npm currently has no existing `orcode` package, so 0.4.1 still needs an
  explicit owner bootstrap publication before npm Trusted Publishing can be
  configured.
- Before the workflow is authorized, GitHub must have `npm-production` with the
  owner as Required Reviewer, prevent-self-review enabled, selected protected
  `v*` deployment refs, and two `v*` tag rulesets: owner-only creation plus
  update/delete with no bypass actors. A distinct trusted maintainer or
  restricted bot must dispatch; only the owner may create release tags, and
  nobody may later update/delete them. A sole owner cannot both
  initiate and approve that protected job.
- Native Windows CI, npm OIDC publication, provenance inspection, and ConPTY
  remain external/runtime evidence. This report does not claim any of them ran
  on the local macOS host.
