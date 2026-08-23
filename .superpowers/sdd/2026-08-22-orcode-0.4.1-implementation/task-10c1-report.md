# Task 10 Slice C1 Report

Base: `587943673f0347c3713acf2ab45946d232cbabf7`

## Scope

- Added central, side-effect-free main/compressor model-role predicates in
  `src/openrouter.ts`; selection call sites remain deliberately unchanged for
  Slice C2.
- Replaced the embedded-NUL session turn identity with an injective JSON tuple.
- Added a repository gate that checks the working-tree bytes of every
  Git-tracked TypeScript source file.

## RED evidence

1. `node --import tsx --test tests/models.test.ts`
   - Exit 1 before production edits.
   - Failed because `isMainModelCandidate` and
     `isCompressorModelCandidate` did not exist.
2. `node --import tsx --test --test-name-pattern='tracked TypeScript source contains no embedded NUL bytes' tests/cli.test.ts`
   - Exit 1 before editing `src/session.ts`.
   - Found exactly `src/session.ts:40512` and `src/session.ts:40525`.

## GREEN evidence

- `node --import tsx --test tests/models.test.ts`: 9 passed.
- Focused byte gate: 1 passed.
- `node --import tsx --test tests/models.test.ts tests/cli.test.ts tests/session.test.ts`:
  67 passed, including all concurrent session-merge regressions.
- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- `npm test`: 853 passed, 0 failed, 1 existing platform skip.
- `git diff --check`: exit 0.

### Pre-existing timing-only test flake

A deliberate repeated focused run reproduced the pre-existing
`concurrent merge distinguishes redaction projection from a local edit` timing
flake once: `Remote turn` and `Local turn` exchanged order when both received
the same millisecond timestamp. All turns remained present. The merge sort is
unchanged by C1 and still orders only by parsed `createdAt`; by explicit ruling,
this unrelated same-ms tie behavior was not changed in this slice. The focused
and full results reported above are fresh green runs after that ruling.

## Result

- Main-role candidates require text input, text output, and tools, failing
  closed when catalogue capabilities are absent. Exact `openrouter/auto` is the
  sole main-only exception.
- Compressor-role candidates require only text output; image/audio/no declared
  input and missing tool support do not exclude them.
- Tracked TypeScript contains no embedded NUL byte, and concurrent merge
  behavior remains covered after the turn-key representation change.
