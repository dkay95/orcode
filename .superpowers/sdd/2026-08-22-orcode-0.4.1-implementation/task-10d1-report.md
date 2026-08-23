# Task 10 Slice D1 Report

Base: `ddfcb7ee1f14e30238f1c0e0505eb26de2b8e550`

## Scope

- Added a read-only OpenRouter runtime-state snapshot with independent
  inference validity, management validity, transport connectivity, and credit
  availability.
- Bound credential rejection only to an actual HTTP 401 response for the
  active credential scope. Permission, credit, expiry metadata, throttling,
  provider, and transport failures preserve the key and its last-known
  validity.
- Kept `reconnecting` visible for the complete reconnect transaction and
  preserved the previous validity across failed reconnect attempts.
- Redacted a not-yet-active management candidate at the transport boundary;
  candidate validation cannot mutate active runtime state.

## RED evidence

`node --import tsx --test --test-name-pattern='credential validity|genuine active-scope|management candidate failures|reconnect exposes' tests/openrouter.test.ts`

- Before production edits: 8 reached, 0 passed, 8 failed.
- Missing contracts were the runtime-state projection, genuine active-scope
  rejection, candidate-secret transport redaction, and observable reconnect
  state.
- First implementation rerun: 7 passed, 1 failed because the first successful
  reconnect sub-request exposed `connected` before the whole reconnect had
  settled.

## GREEN evidence

- Exact runtime-state focus including management-only rejection and
  last-known-valid preservation: 10 passed, 0 failed.
- Full `tests/openrouter.test.ts`: 37 passed, 0 failed.
- `npx tsc --noEmit`: exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- Credential-shaped literal audit over the two changed source/test files: no
  matches.
- `git diff --check -- src/openrouter.ts tests/openrouter.test.ts`: exit 0.

## Result

RouterCode can now report "key validity", "connection", and "credit" without
collapsing them into one destructive boolean. A reachable 403 does not mean an
invalid key, insufficient credit does not mean a broken connection, and an
offline provider does not erase a previously valid credential. Persistence,
explicit save/forget consent, and the unified CLI/TUI key flow remain the next
Slice D step.
