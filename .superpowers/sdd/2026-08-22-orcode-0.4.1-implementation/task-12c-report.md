# Task 12c Report — Historical migration release fixture

## Scope

- Added one committed, sanitized unversioned app-home fixture at
  `tests/fixtures/app-home-v0/`.
- Added an end-to-end release-gate regression to
  `tests/app-home-migration.test.ts`.
- No production source was changed.

## Fixture coverage

The fixture represents the pre-schema app home and contains only synthetic
values:

- unversioned config, including legacy `verify.maxRounds`;
- v1 approval rules with one safely convertible literal path and one disabled
  broad command prefix;
- one v2 transcript and its exact opaque SDK state sidecar;
- one legacy bare-event NDJSON run;
- one exact checkpoint.

The test copies those committed bytes into a fresh temporary `.routercode`
home and enters through `initializeStartupStorage`. Only the home migration and
retention seams are injected: migration calls the real `migrateAppHome`, while
retention is disabled so the migration result itself is stable. Global fetch
and every credential-store method are fail-fast traps.

The gate proves:

- startup selects the migrated `.orcode` home and opens the mapped chat;
- the manifest is current and complete, with one stable old-to-new chat ID;
- transcript data is preserved except for the required mapped ID;
- SDK state is still parseable, remains byte-for-byte identical internally,
  and receives only the mapped outer chat ID;
- legacy run events become current v1 envelopes without event loss or reorder;
- checkpoint bytes remain exact and pass the production parser;
- config is current, preserves model/reasoning values, and maps total-pass
  `maxRounds: 2` to `maxRepairRounds: 1`;
- rules become v2, preserve the exact safe rule, and disable the ambiguous
  prefix rule;
- the protected backup has exactly the committed fixture bytes;
- a second real startup changes no app-home file byte and returns identical
  config/session/rule state;
- fetch/network and credential-store call counts remain zero.

## TDD evidence

- RED: 20 existing tests passed and the new test failed with `ENOENT` for the
  not-yet-created `tests/fixtures/app-home-v0` directory.
- GREEN: after adding only the fixture, the focused migration file reached
  21/21 passing. Two test-expectation corrections captured the established
  mapped-ID prefix and the intentionally optional in-memory legacy-rule detail;
  production required no change.

## Fresh verification

- `node --import tsx --test tests/app-home-migration.test.ts`: 21/21 passed.
- `npx tsc -p tsconfig.json --noEmit`: exit 0.
- `npx tsc -p tsconfig.tests.json --noEmit`: exit 0.
- Central fixture credential scan plus private absolute-path audit: 0 findings.
- `git diff --check`: exit 0.

No live home, keychain, provider, network service, tag, or registry was touched.
