# Task 10 Slice D2 Report

Implementation base: `b633638` (parallel Slice A/B/C commits were integrated
before the final D2 commit).

## Scope

- Made keychain replacement transactional: every save verifies exact readback,
  restores the previous key after a partial failure, and removes a partially
  written first key. Every delete verifies absence and keeps a retryable active
  key until persistent deletion has succeeded.
- Kept environment keys process-only by default in plain, non-interactive, and
  fullscreen startup. `/key save` is the only implicit-environment-to-keychain
  transition.
- Unified `/key replace`, `/key save`, `/key status`, and `/key forget` across
  plain and fullscreen mode, including the management-key equivalents.
- Validated every candidate against its own bearer scope before mutating the
  active key or persistence. A keychain failure offers process-only use only
  after explicit confirmation and never creates a plaintext fallback.
- Split forget into exactly one confirmation followed by persistent deletion
  and only then in-memory removal. Decline and deletion failure leave both
  states unchanged; an explicit retry remains possible.
- Kept 403, expiry/limit, credit, offline, timeout, and provider failures
  non-destructive. `/key status` shows origin, last-known credential validity,
  connectivity/reconnect state, and credit state independently.

## RED evidence

The D2 tests were added before production edits and initially failed on the
missing lifecycle contracts:

- environment startup attempted implicit persistence;
- saved-key rejection deleted or replaced persistence before a candidate was
  validated;
- dashboard mode bypassed the shared slash-command lifecycle;
- keychain partial writes and ignored deletes were not verified or rolled
  back;
- replace/forget lacked explicit process-only and persistent-first boundaries;
- candidate validation had no isolated inference-key API;
- status collapsed connectivity failures into credential replacement.

Individual RED-to-GREEN cycles covered the inference candidate request,
transactional save/delete, explicit `/key save`, one-confirmation forget,
process-only replace decline/accept, rejected candidates, offline status, and
management-key symmetry.

The independent pre-commit review then found three additional P1 boundaries.
Their exact follow-up matrix was RED with 9 reached, 0 passed: equal candidate
bytes inherited an active request scope, a context-free candidate 401 could
start the outer replacement flow, and plain startup threw on offline, 403, or
an exhausted limit. After the fixes, the same matrix passed 9/9. Candidate
requests now carry an explicit scope and interactive plain startup remains
available for `/key status` and `/reconnect` while non-interactive runs still
fail before attempting a model call.

The review's storage pass found five further P1 cases. The exact follow-up
matrix was RED with 9 reached, 0 passed and is now GREEN 9/9: unreadable
rollback verification is typed as an unknown persistence state; unsafe state
can never fall back to process-only activation; previous, candidate, and
unknown credential-shaped backend details are centrally redacted; active
inference/management requests carry semantic scopes even when both keys have
identical bytes; and explicit `/key save` persists an authenticated key
independently of expiry or available credit. Spendability remains enforced at
the model-run boundary.

## GREEN evidence

- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- Combined final D2 focus (`commands`, `cli`, `openrouter`, `credentials`,
  `reconnect`): 131 passed, 0 failed.
- `tests/cli.test.ts`: 28 passed, 0 failed.
- Full `npm test`: 943 reached, 942 passed, 0 failed, 1 existing
  platform-dependent skip.
- Credential-shaped literal audit over `tests` and `README.md`: no matches.
- `git diff --check`: exit 0.
- Independent post-fix re-review: APPROVED, 18/18 adversarial boundary
  checks passed and no remaining P0/P1 was found.

## Result

A saved key remains the default across restarts. An environment key is usable
without being silently stored, and the user can explicitly promote it with
`/key save`. Replacement is candidate-first, forget is persistent-first, and
network or billing state can no longer erase a valid credential. Plain and
fullscreen mode now share the same lifecycle instead of maintaining two subtly
different key flows.
