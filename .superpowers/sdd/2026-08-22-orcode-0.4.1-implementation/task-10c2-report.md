# Task 10 Slice C2 Report

Requested base: `ddfcb7ee1f14e30238f1c0e0505eb26de2b8e550`

The shared branch advanced to Task 10 D1 commit
`b63363858075e4d8635e80fd29232f887b6c1de1` while C2 was in progress. D1 did
not touch the four C2 source/test files, and the final C2 gates include that
landed change. Concurrent uncommitted A/B/D2 paths remain excluded from the C2
commit.

## Scope

- Added one catalogue-resolution contract in `src/commands.ts` for exact main
  and compressor role candidates. A successful exact catalogue match is
  checked with the C1 predicates before any config/session mutation.
- Preserved catalogue/network error identity. A successful catalogue lookup
  distinguishes a missing exact ID from a found-but-incompatible model.
- Wired the contract into `/model` picker/exact/current, `/models`,
  `/compress model` picker/exact, and the current-model lookup used by
  reasoning metadata.
- Wired the same filters into both dashboard pickers and the dashboard model
  snapshot. The snapshot distinguishes available, incompatible, missing, and
  temporarily unavailable states; the unavailable result retains the original
  error for retry/diagnostics.
- Added a run-boundary gate for prompt/JSON, plain-loop, and dashboard runs.
  The gate validates the effective main value after `--model`/session/config
  precedence, and validates the compressor when compression is active, before
  `agent.run` is entered.
- Kept exact `openrouter/auto` as the only catalogue-independent main route.
  Compressor candidates require text output only and may have image/audio/no
  text input and no tools.
- Did not modify `src/agent.ts` or any C1 production file.

## RED evidence

Before production edits:

```text
node --import tsx --test tests/commands.test.ts tests/cli.test.ts
```

Result: 31 passed, 7 failed. The failures proved that:

- `/models` exposed no-tools/no-text-input/no-text-output candidates;
- exact and current incompatible main IDs were accepted;
- explicit `openrouter/auto` unnecessarily queried the catalogue;
- an image-to-text compressor without text input was rejected;
- no CLI run-boundary gate or role-aware dashboard snapshot existed.

The retryability control was already green: the exact slash path rethrew the
same synthetic catalogue error object without mutation.

A second fail-first dashboard-picker test produced 2/2 expected failures while
the role filtering existed but the real picker functions were not yet exposed
to the behavioral test. Exporting those production functions, without a
parallel test-only implementation, made the same test green.

## GREEN evidence

- `node --import tsx --test tests/models.test.ts tests/commands.test.ts tests/cli.test.ts`:
  49 passed, 0 failed.
- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- Fresh `npm test`: 897 passed, 0 failed, 1 existing platform skip (898 total).
- Central credential scanner over all test sources plus README: exit 0, no
  findings.
- Literal credential audit for `sk-or-`, `AKIA`, `glpat-`, and `npm_`: no
  matches.
- `git diff --check`: exit 0.
- Callsite audit: every main/compressor catalogue surface in
  `src/commands.ts` and `src/cli.ts` now requests the unfiltered catalogue and
  applies its explicit role predicate; the remaining unfiltered command
  catalogue call belongs to the separate tool-free panel proposal.
- Run-boundary audit found exactly the prompt/JSON, plain, and dashboard gates
  before their respective `agent.run` calls.

## Result

All allowed C2 selection, display, and run surfaces share the C1 role
semantics. Found incompatible values fail before mutation or model execution;
missing IDs are not mislabeled as capability failures; transport/catalogue
failures remain distinguishable and retryable; and dynamic `openrouter/auto`
does not add a catalogue dependency.
