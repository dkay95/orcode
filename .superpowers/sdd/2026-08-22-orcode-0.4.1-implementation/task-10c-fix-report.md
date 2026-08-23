# Task 10 Slice C — Independent Review Fix Round 1

## Scope and findings

- Baseline: `20c39c7` (`fix: share browser and ssh operation state`).
- Review finding 1: `/fallback +<id>` persisted an arbitrary model ID without
  the Main-role capability gate, and the final run gate checked only the
  primary and compressor models even though every configured fallback enters
  the same real OpenRouter main request.
- Review finding 2: an explicit `--model` replaced `config.mainModel` and the
  session preference before its first role-aware catalogue check. The initial
  fullscreen chat picker can save those preferences before the first run.
- Production changes remain limited to `src/commands.ts` and `src/cli.ts`.
  Regressions live in `tests/commands.test.ts` and `tests/cli.test.ts`.
- The root authorized one minimal scope extension to
  `tests/integration.test.ts`: its old live-catalog IDs had become invalid, so
  that existing round-trip test now injects two deterministic, fully
  Main-compatible catalogue fixtures. No production semantics are defined in
  that fixture.

## Fail-first evidence

Before either production file changed:

`node --import tsx --test --test-name-pattern='slash fallback addition|configured run gate validates every fallback|configured fallback validation|explicit startup model validates' tests/commands.test.ts tests/cli.test.ts`

reached 7 leaves and was RED 0/7:

- both no-tools and no-text fallback candidates were persisted instead of
  rejected;
- the run gate never reached either a bad configured fallback or its catalogue
  outage; and
- the startup fail-before-mutation helper/contract did not exist.

The first full-suite run after the production fix was 970 passed, 1 failed,
1 skipped. The sole failure was the pre-existing integration round trip adding
retired live IDs (`anthropic/claude` and `openai/gpt`). This was a stale
external fixture, not a production fallback escape; it was replaced only after
the explicit root scope ruling above.

## Implemented contracts

- `/fallback +<id>` calls the existing exact `resolveMainModelCandidate`
  before constructing or saving the next chain. Capability, not-found, and
  catalogue errors therefore occur before config mutation.
- `openrouter/auto` keeps only the resolver's existing exact Main-role
  exception. No prefix, suffix, compressor, or unknown-ID exception was added.
- `ensureRunnableModelConfiguration` checks the primary, every configured
  fallback in order, and the enabled compressor immediately before each plain,
  fullscreen, prompt, or JSON run. The original error object is never wrapped.
- `applyStartupModelPreference` validates an explicit `--model` before
  changing `config.mainModel` or calling `SessionStore.setPreferences`. The
  early assignment was removed; session/config defaults retain their existing
  behavior when no explicit override is supplied.

## Verification

- New regression matrix: 7 passed, 0 failed.
- Commands/command-catalog/CLI/entrypoint/models focus: 94 tests passed,
  0 failed.
- Deterministic integration fallback round trip: 1 passed, 0 failed.
- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- Fresh `npm test`: 972 tests, 971 passed, 0 failed, 1 existing platform skip.
- `git diff --check`: exit 0 before staging.
- Independent read-only P0/P1 re-review: **APPROVED**, no findings. Its
  focused matrix passed 8/8, the integration fallback passed 1/1, and both
  TypeScript checks plus diff-check exited 0.
