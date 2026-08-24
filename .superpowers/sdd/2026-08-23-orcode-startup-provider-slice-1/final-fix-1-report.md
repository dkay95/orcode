# Final Whole-Branch Fix 1 Report — Central Provider Credential Authority and Startup Budget

## Base, scope, and invariants

- Exact base and current pre-commit `HEAD`:
  `b85a173abf4785134f4738d97ebb89868d043093`.
- The approved provider setup Spec, Slice-1 Plan, and its Global Constraints
  remained byte-unchanged.
- Scope stayed within Final Fix 1: OpenRouter Stable only, Anthropic remains
  descriptor-only Coming soon, and no Codex/Anthropic auth/runtime or new Cross
  behavior was added.
- No setup-cancellation, legacy-logout, session-route-persistence, or TUI
  lifecycle behavior from Final Fixes 2/3 was implemented.
- Provider mutation ownership remains runtime guard -> provider lease. Primary
  operation errors retain precedence over release errors, and generation/fence
  checks precede publication.
- Secrets are exposed only inside callback scope. No raw credential, provider
  body, account creator identifier, private journal path, or dependency error is
  returned in provider result/event/error output.

## Formal tests-only RED — production byte-unchanged

Before any production edit, the complete required test matrix was added on top
of the exact base. `HEAD` and merge-base both resolved to `b85a173...`, and the
production diff against that base was empty.

The formal tests-only run reached 549 tests: 526 passed and 23 failed. There
were no harness or TypeScript failures. The matrix contained these 22 named
top-level behavioral gates; the startup-abort gate additionally exercised the
named `recover`, `inspect`, and `automatic` phase subtests:

### Credential authority and exact adapter binding

1. `pending forget blocks saved and environment credentials before every read`
2. `unknown versioned credential pointer fails closed without legacy or environment fallback`
3. `disabled connection performs zero credential and environment reads during startup`
4. `explicit enable reads only the retained disabled connection slot`
5. `automatic environment eligibility exists only after authoritative saved absence`
6. `two enabled connections inspect only their own exact slots and reduce the exact default`
7. `duplicate account realm bindings are ambiguous instead of selecting the first connection`
8. `authority discards a credential permit when the durable binding changes before use`
9. `runtime binding follows the newly committed v1 slot in the same process`
10. `parallel connection inspections cannot exchange credentials or active proofs`
11. `status reconnect default and confirmation select the same exact provider binding`
12. `default second after nondefault first still requires exactly one destructive confirmation`
13. `confirmation becomes stale when only the authoritative credential pointer changes`
14. `explicit enable reuses the retained slot without replacement allocation`
15. `process-only disable revokes automatic environment eligibility for later prompts`

### One whole-startup attempt

1. `whole startup deadline includes pre inspection activation recovery`
2. `seven seconds of recovery leave only one second for provider probes`
3. `automatic environment setup cannot reset or exceed the original startup deadline`
4. `startup abort reaches recovery inspection and automatic activation with one generation`
5. `late startup generation cannot publish health state or bind a runtime key`
6. `manual setup after startup timeout receives an independent interactive attempt`
7. `pending committed activation journal with never-resolving connect/catalog retains journal and returns fail-closed at bound`

The REDs used real coordinator/runtime/adapter seams, exact saved-slot-present
and saved-slot-absent plus environment pending-forget variants, fake-clock
whole-deadline proofs, and dependencies that ignore Abort where required.

## Production correction

### One connection-bound authority

- `src/provider-authority.ts` is now the single durable binding and credential
  authority. It parses only exact `legacy:inference` and canonical
  `v1:inference:<UUID>` pointers and classifies none, ambiguity, invalid
  pointer, pending forget, and recovery-required states without fallback.
- Credential access receives an exact connection, purpose, environment policy,
  deadline, and signal. It reads under the provider coordinator, reasserts the
  exact durable binding/fence before release, and invokes the secret callback
  only after releasing provider ownership.
- Automatic environment eligibility is process-local and fail-closed for
  disabled, ambiguous, invalid/unreadable saved, unknown-pointer, and pending
  recovery/forget states. A process-only disable revokes later automatic reuse.
- Explicit enable may read only its retained disabled slot under the existing
  ownership and does not reserve or write a replacement.

### Exact multi-connection runtime behavior

- Adapter inspection/reconnect/model listing and runtime binding carry an exact
  connection ID. Constructor-time inference slot, connection, and environment
  credential snapshots were removed.
- Active inspection proof is keyed by connection. Parallel probes cannot swap
  credentials or mutate the singleton OpenRouter service.
- Status, reconnect, default/runtime binding, destructive confirmation, model
  transition, `/key save|replace`, setup reuse, and persisted-session route
  validation use the same exact selector. Duplicate account/realm matches fail
  closed as ambiguous instead of using `.find()`/first-match behavior.
- The singleton service binds only after the exact route is proved. Durable
  activation preflights both config and provider-state revision before any
  candidate network call, then repeats the durable CAS/readback fence before
  publication.
- Committed recovery cleans the old slot before runtime binding. The journal
  remains present through potentially unbounded candidate/catalog work and is
  removed only after authenticated proof, preventing a timed-out recovery from
  leaving a credential silently active.

### One startup budget and generation

- A single startup attempt starts before activation/forget recovery and carries
  one absolute deadline, signal, generation, and current-attempt fence through
  recovery, binding preparation, inspection, legacy lookup, automatic
  environment setup, catalog, activation, and final bind.
- Every phase uses the remaining budget; no substep restarts the 8-second
  window. Abort-ignoring dependencies are raced, late results cannot publish,
  and connected late candidates are explicitly discarded.
- Timeout is not treated as user cancellation. A later manual setup gets its
  own independent interactive attempt.

## Adversarial RED/GREEN rounds

Every behavioral correction found after the first GREEN received a named RED
before production changed.

### Review round 1 — 8 RED, then 8 GREEN

- exact `/key` target connection rather than appending an ambiguous duplicate;
- `committed recovery cleans the old slot before binding the runtime`;
- `automatic management environment is forbidden for a versioned connection`;
- `fresh never-configured environment activation stays ready without a durable bind`;
- `model transition uses the exact route credential and preserves its connection id`;
- `provider setup re-reads a changed durable pointer instead of cached persisted secret`;
- `disable fails closed when the exact session binding becomes ambiguous before mutation ownership`;
- `startup abort revokes a connected candidate even when catalog ignores abort forever`.

### Review round 2 — 3 RED, then 3 GREEN

- `inference key save reads the exact durable credential instead of the stale runtime service`;
- `provider setup carries the authority revision across a delayed model prompt`;
- `persisted session route fails closed when duplicate account realm bindings become ambiguous`.

### Review round 3 — 3 RED, then 3 GREEN

- `inference key save rejects a route decision from before the authority revision`;
- `model transition rejects an authority binding from a newer route revision`;
- `stale expected revision blocks candidate network before activation`.

Additional activation recovery ordering/fence controls, including
`lost runtime guard during recovery bind happens only after old-slot and journal cleanup`,
remained green. The final independent adversarial review found no P0/P1. Its
last spot pass verified 126/126 authority plus activation tests, both TypeScript
projects, and `git diff --check`.

## Test-harness-only timing ruling

The first serial affected focus reached 637 tests with 636 passed and one
failure in the unchanged base test
`concurrent merge distinguishes redaction projection from a local edit`.
Isolated stress reproduced the base millisecond-timestamp tie: 9/10 passed and
1/10 failed, with local/remote turns receiving the same `createdAt` and the
stable merge retaining insertion order. Both `src/session.ts` and the original
test were byte-identical to base at diagnosis.

The controller explicitly approved a test-harness-only correction: the
existing test now assigns Remote `base + 1ms` and Local `base + 2ms`. No Session
production behavior changed. The named stress then passed 21/21. This is kept
as a separate scope ruling and is not a Final Fix 2 behavior change.

## Frozen verification

After the last production edit and independent review, production was frozen.

- Named Session timing stress: 21/21 passed.
- Serial affected focus (authority, backends, adapter, activation, setup,
  setup-ui, CLI/entrypoint, integration, credentials, config, commands/catalog,
  sessions, privacy, and real PTY): 637/637 passed; 0 failed, 0 skipped.
- `npx tsc -p tsconfig.json --noEmit`: PASS.
- `npx tsc -p tsconfig.tests.json --noEmit`: PASS.
- `node --import tsx scripts/render-command-docs.ts --check`: PASS — README
  command docs current.
- Approved Spec/Plan diff, including Global Constraints: empty.
- `git diff --check`: PASS.

Exactly one captured full suite was run after freeze:

```text
npm test -- --test-reporter=spec
1,529 tests reached; 1,528 passed; 0 failed; 1 skipped; 0 cancelled.
```

The sole skip was the existing non-Windows platform gate
`Windows PrivateStore real DACL integration`. The complete command exited 0 in
24.77 seconds and was not repeated.

## Build, package, release, and privacy gates

- `npm run build`: PASS.
- `node scripts/check-package.mjs`: PASS — `orcode@0.4.1`, 175 files, both bin
  shims verified.
- `node scripts/check-release-metadata.mjs --tag v0.4.1`: PASS — release tag
  and package metadata agree.
- `node --import tsx --test --test-reporter=spec tests/provider-privacy.test.ts`:
  3/3 passed, 0 failed, 0 skipped.
- Final `git diff --check`: PASS.

## Files in the commit

Production:

- `src/provider-authority.ts`
- `src/backends.ts`
- `src/openrouter-backend.ts`
- `src/provider-activation.ts`
- `src/provider-state.ts`
- `src/setup.ts`
- `src/setup-ui.ts`
- `src/cli.ts`

Tests and mechanical fixtures:

- `tests/provider-authority.test.ts`
- `tests/openrouter-backend.test.ts`
- `tests/provider-activation.test.ts`
- `tests/setup.test.ts`
- `tests/setup-ui.test.ts`
- `tests/cli.test.ts`
- `tests/provider-privacy.test.ts`
- `tests/fixtures/provider-setup-pty-harness.mjs`
- `tests/session.test.ts` — approved deterministic test-harness timing only.

Evidence:

- `.superpowers/sdd/2026-08-23-orcode-startup-provider-slice-1/final-fix-1-report.md`

Exact commit subject: `fix: centralize provider credential authority`.
