# Native Windows acceptance record

Status: development checkpoint, **not Windows-ready**. Windows 11 x64 without
WSL is the approved target. A Windows Server GitHub runner is not Windows 11
installation or GUI acceptance.

## Evidence recorded on 15 October 2026

- Build/platform split: native shell and test compilation passed at `bab96a7`
  ([run 38654578088](https://github.com/dkay95/orcode/actions/runs/38654578088)).
- Job/process identity/overlapped pipe primitives: native compilation passed at
  `feb49a3` ([run 38656328207](https://github.com/dkay95/orcode/actions/runs/38656328207)).
  That run failed two positive Mac `/Volumes` fixture tests on Windows; it did
  not proceed to the separate native process/pipe test binary. This is not a
  runtime pass.
- The fixture split and explicit Windows refusal of Mac attestation are in
  `5605287`. Its [native execution run 38657183496](https://github.com/dkay95/orcode/actions/runs/38657183496)
  passed. The process/pipe tests verified suspended creation-time Job ownership,
  grandchild death on shell abort, non-inheritance of an extra inheritable handle,
  foreign-peer refusal, bounded cancellation and stalled writes, retirement
  fencing, Unicode/quoted argument roundtrip and exit-code 259 handling. These
  test isolated primitives, not the unfinished Core/helper integration.
  Counts: 45 library + three lifecycle + two owner contracts + 11 process/pipe
  tests; 42 TypeScript protocol/action contracts, zero failed or skipped.
- The additional positive retained-peer/Job verification at `2ecfecf` also
  passed ([run 38657923463](https://github.com/dkay95/orcode/actions/runs/38657923463)):
  62 native tests and 42 TypeScript contracts, zero failed or skipped.
- Local account-free protocol/action contracts: 42 passed, zero failed/skipped.
  Root and test TypeScript checks pass. Mac native verification retains all 46
  library tests, 24 lifecycle tests, two new owner-correlation contracts and the
  compile-fail trust test.
- Focused independent review found an I/O retirement race and an inherited-array
  validation bypass; both were corrected with regression tests. This is not the
  required final whole-branch review.

The Windows engine/setup path remains deliberately unavailable. The new JSON
gates prove correlation only, not native owner or publisher authority. No
credentials, subscription use, account login or paid model turn was involved in
this checkpoint.

## Not yet accepted

- Actual Core-to-helper private bridge, independently pinned executable/resource
  identity and generation-bound native owner capability.
- NTFS workcopies/journals, AppContainer write/network/descendant canary,
  process-tree Stop and checked Apply/recovery.
- Verified manufacturer setup; installation/login/subscription/GUI-runnable
  remain separate states. No untested provider is declared runnable.
- Bundled-runtime NSIS installer and resource-only cold start.
- Standard-user Windows 11 installation, real GUI project/model/agent journey,
  installed-artifact hashes, upgrade/uninstall preservation and final independent
  review.

Manual model selection, separate AI-process/Permissions controls and Abo-first
without paid fallback remain requirements, not acceptance evidence.
