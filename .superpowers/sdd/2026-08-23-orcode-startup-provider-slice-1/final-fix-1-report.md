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

## Final Fix 1 re-review addendum — manual deadline and durable adoption

This addendum was completed on the frozen, intentionally uncommitted Fix 1
worktree at `HEAD` `8d17a0c11f12efc5e8d3a9534e94ec2df113fc6d`.
No existing change was reset or rewritten, and no commit was created.

### Pre-change freeze and formal RED

- `git diff -- src tests` SHA-256:
  `24a7feba74dca5e82d6a8cdb3992124d6d1be9a1dce7a06a1b9a50ea861d0c24`.
- `git diff -- src` SHA-256:
  `72a9d14f6b50a072103df893c36d2e3b519c876ab8c9d3a6cbfe161b8c151fb1`.
- After adding only the two regression tests, the source-only hash remained
  exactly `72a9d14f6b50a072103df893c36d2e3b519c876ab8c9d3a6cbfe161b8c151fb1`.
- The exact focused RED reached 2 tests: 0 passed, 2 failed, 0 skipped:
  - `manual saved setup authority expiry aborts hub and forbids late activation`
  - `post-readback cancellation adopts the exact committed provider state without a half tuple`
- Both failures were the required behavioral failures: the late manual model
  prompt performed one activation plus two presentations after settlement,
  and the durable file held the new revision while the in-memory store exposed
  no exact committed outcome.

### Central correction

- Independent manual setup now owns one abort controller and absolute 8-second
  deadline. That same signal/deadline is threaded through saved-credential
  authority, candidate authority, and `runSetupHub`; settlement aborts the
  owner so an already-detached prompt cannot publish later effects. Startup
  attempts continue to use their existing caller-owned signal, deadline, and
  generation.
- Exact durable config readback now invokes a `ProviderStateStore`-issued
  WeakMap capability. A structurally forged request receives only the ordinary
  checked adoption path. The genuine post-readback path rechecks currentness,
  adopts only the byte-exact built candidate even when that final check reports
  late cancellation, and returns the existing private typed committed outcome
  without preserving or exposing the raw cancellation cause.
- Existing retained-enable handling consumes that typed outcome into the full
  State/Config/Runtime tuple; the pre-existing retained-enable adopted-outcome,
  wrong-readback, post-commit-fence, and runtime-bind ordering tests remained
  green.

### GREEN and final freeze

- Exact two-test GREEN: 2/2 passed, 0 failed, 0 skipped.
- Direct serial focus (`cli`, provider authority, provider state): 203/203
  passed, 0 failed, 0 skipped.
- Serial affected provider focus (authority/state/backends/adapter/activation,
  setup/UI, CLI/entrypoint, integration, credentials/config, commands/catalog,
  sessions, privacy, and real provider PTY): 685/685 passed, 0 failed, 0
  skipped.
- `npx tsc -p tsconfig.json --noEmit`: PASS.
- `npx tsc -p tsconfig.tests.json --noEmit`: PASS.
- `node --import tsx scripts/render-command-docs.ts --check`: PASS.
- Provider privacy: 3/3 passed, 0 failed, 0 skipped.
- `git diff --check`: PASS.
- Approved Spec SHA-256 remained
  `e15d19821fafbac1f0fc21dd82702d41efa481a12bdcee97df238de2ee85f021`.
- Approved Plan SHA-256 remained
  `74914bc2e38c1ac7bb8b57dbfa0abfb1963d4da7acc3fbb6868434039ce22b2c`.
- Final `git diff -- src tests` SHA-256:
  `1dcf8527b08685d82e064845cfb014a1cb444d3a8925ab9c381b30a3850baf82`.
- Final `git diff -- src` SHA-256:
  `8b4b428ba6a8b921b1568376691050f1a7eba9daceaeaf2d85e43c7f919df391`.

Files changed by this addendum only:

- `src/cli.ts`
- `src/provider-state.ts`
- `tests/provider-authority.test.ts`
- `tests/cli.test.ts`
- this report

No global/full `npm test` was run, per the re-review constraint.

## Final Fix 1 delta — terminal retained commit and unforgeable outcome

This final delta was completed on the frozen, intentionally uncommitted Fix 1
worktree at `HEAD` `8d17a0c11f12efc5e8d3a9534e94ec2df113fc6d`.
No existing change was reset or rewritten, and no commit was created.

### Pre-change freeze and formal RED

- `git diff -- src tests` SHA-256:
  `1dcf8527b08685d82e064845cfb014a1cb444d3a8925ab9c381b30a3850baf82`.
- `git diff -- src` SHA-256:
  `8b4b428ba6a8b921b1568376691050f1a7eba9daceaeaf2d85e43c7f919df391`.
- After adding only the two regression tests, the source-only hash remained
  exactly `8b4b428ba6a8b921b1568376691050f1a7eba9daceaeaf2d85e43c7f919df391`.
- The exact focused RED reached 2 tests: 0 passed, 2 failed, 0 skipped:
  - `retained enable does not settle or logout before a late genuine durable-adoption outcome`
  - `committed provider outcome rejects a prototype-shaped object with an own readCommitted override`
- The failures demonstrated both reported defects: retained enable had already
  settled at its deadline while the genuine durable adoption was still pending,
  and a prototype-shaped object with an own virtual reader decoded as committed.

### Central correction

- Retained enable now awaits `ProviderStateStore.commit` to its exact terminal
  result instead of racing and detaching that persistence operation at the
  provider deadline. Once durable publication may have begun, the activation
  lease and caller remain owned until the store proves either an unchanged old
  tuple or an exact privately branded committed tuple. Cleanup and authority
  release therefore cannot race a still-capable late adoption. Abortable
  catalog and other pre-commit provider work retain their existing deadline.
- Committed provider outcomes are now recorded in a module-private `WeakMap`
  keyed by the exact error object. The decoder reads that map directly and
  returns a clone; it no longer trusts `instanceof`, an error name, a prototype,
  or a dynamically dispatched `readCommitted` method.
- The two pre-existing stalled/adopted persistence tests were aligned with the
  terminal contract: they prove no early settlement or ownership release and
  then verify the exact old or committed tuple after persistence settles.

### GREEN and final freeze

- Exact two-test GREEN: 2/2 passed, 0 failed, 0 skipped.
- Direct serial provider state + authority focus: 102/102 passed, 0 failed, 0
  skipped.
- Required serial provider state/authority/activation/CLI focus: 299/299
  passed, 0 failed, 0 skipped.
- `npx tsc -p tsconfig.json --noEmit`: PASS.
- `npx tsc -p tsconfig.tests.json --noEmit`: PASS.
- `node --import tsx scripts/render-command-docs.ts --check`: PASS.
- Provider privacy: 3/3 passed, 0 failed, 0 skipped.
- `git diff --check`: PASS.
- Approved Spec SHA-256 remained
  `e15d19821fafbac1f0fc21dd82702d41efa481a12bdcee97df238de2ee85f021`.
- Approved Plan SHA-256 remained
  `74914bc2e38c1ac7bb8b57dbfa0abfb1963d4da7acc3fbb6868434039ce22b2c`.
- Final `git diff -- src tests` SHA-256:
  `68d04a34338e04e42d2fc14347e21411e82a8b1430be5a01552861c142918546`.
- Final `git diff -- src` SHA-256:
  `7da250c3c882226683f65ce796c7998cf79d10b38db9b67a4a282f7fab41120c`.

Files changed by this delta only:

- `src/cli.ts`
- `src/provider-state.ts`
- `tests/provider-authority.test.ts`
- `tests/provider-state.test.ts`
- this report

No global/full `npm test` was run, per the final-delta constraint.

## Integrated Fix Round 1 — terminal provider effect fences

This integrated round started from clean `HEAD`
`21bef89843b604fc5a66cd644a423847827a33d1`. It preserves the merged Fix 1
authority, Fix 2 session/logout, and Fix 3 terminal-lifecycle boundaries. No
subscription, Kimi, version, approved Spec, or approved Plan content changed.

### Formal tests-only RED

- The pre-change `src` tree was exactly
  `50677e8a175949dc83dc06ab9b16306b83e4aea7`.
- After adding the complete regression matrix and before editing production,
  the `src` tree was still exact and `git diff HEAD -- src` was empty with
  SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Formal result: 11 tests, 1 passed, 10 failed, 0 skipped. The one already
  passing characterization was the post-publication cancelled-state
  reconciliation case.

The exact named matrix was:

1. `transitionModel deadline fences a delayed prepublication activation`
2. `transitionModel publication boundary waits for exact terminal reconciliation`
3. `inference key save deadline fences a delayed prepublication activation`
4. `saved candidate swap after catalog and model choice has zero activation effects`
5. `environment candidate swap after catalog and model choice has zero activation effects`
6. `saved candidate permit survives catalog and model choice into activation`
7. `environment candidate permit survives catalog and model choice into activation`
8. `DefaultProviderRuntime propagates aborted setup cancellation persistence rejection`
9. `DefaultProviderRuntime reconciles a committed cancelled lifecycle after persistence rejects`
10. `real activation writer abort microtask at the last async fence preserves the old tuple`
11. `real activation writer lease expiry microtask cannot rename after the last async fence`

### Central correction

- Model transitions and inference-key save/replace now own one absolute
  deadline and abort signal across credential authority and activation. A
  started activation is retained to its terminal result; a deadline cannot
  return while that promise may still publish config, state, runtime, or
  session effects.
- Opaque candidate permits now survive catalog/model selection and are
  revalidated under the already-held Runtime -> Provider ownership before
  candidate I/O and before durable publication. Saved-slot and environment
  secret changes fail closed without nested provider acquisition.
- Setup cancellation persistence errors are no longer swallowed. The runtime
  reports `cancelled` only after the exact expected cancelled revision is
  authoritative; a detached outer credential deadline now waits for the
  already-started hub cancellation to commit or to return its safe persistence
  failure.
- Activation supplies the atomic writer's synchronous final `beforeRename`
  hook. Immediately before rename, with no await/yield, it checks the owned
  deadline signal, provider lease expiry, and the production runtime guard.
  Exact post-rename readback classifies old/candidate/ambiguous publication;
  after candidate publication is proven, adoption continues under retained
  Runtime -> Provider ownership using a non-caller-abort signal.

### Final verification and freeze

- Formal named matrix: 11/11 passed, 0 failed, 0 skipped.
- Provider state/authority/activation/setup/UI, serial: 305/305 passed, 0
  failed, 0 skipped.
- CLI/commands/session, serial: 217/217 passed, 0 failed, 0 skipped.
- TUI/provider PTY/provider privacy, serial: 98/98 passed, 0 failed, 0 skipped.
- Integration focus: 30/30 passed, 0 failed, 0 skipped.
- Provider privacy standalone: 3/3 passed, 0 failed, 0 skipped.
- `npx tsc -p tsconfig.json --noEmit`: PASS.
- `npx tsc -p tsconfig.tests.json --noEmit`: PASS.
- `node --import tsx scripts/render-command-docs.ts --check`: PASS.
- `git diff --check`: PASS.
- Approved Spec SHA-256 remained
  `e15d19821fafbac1f0fc21dd82702d41efa481a12bdcee97df238de2ee85f021`.
- Approved Plan SHA-256 remained
  `74914bc2e38c1ac7bb8b57dbfa0abfb1963d4da7acc3fbb6868434039ce22b2c`.
- Final pre-commit `git diff HEAD -- src tests` SHA-256:
  `8042b511727b3270baf16b8f5052fb5ee843f647ea0210d5ec74aa5c47ce022f`.
- Final pre-commit `git diff HEAD -- src` SHA-256:
  `dacb867127db565b800ae732811632dc8989fbfa9a261a6de304b260ee3ff3f6`.

Files changed by this round:

- `src/cli.ts`
- `src/provider-activation.ts`
- `src/provider-authority.ts`
- `src/setup-ui.ts`
- `src/setup.ts`
- `tests/cli.test.ts`
- `tests/integration.test.ts`
- `tests/provider-activation.test.ts`
- `tests/provider-authority.test.ts`
- `tests/provider-privacy.test.ts`
- `tests/setup-ui.test.ts`
- `tests/setup.test.ts`
- this report

No global/full `npm test` was run, per the integrated-review constraint.

## Integrated Fix Round 2 — activation ownership reconciliation

This round started from clean `HEAD`
`30a377e057ebc5bd0743dbee77e15db41d4e380b`. Scope remained exactly the
two security-review P1s: lock-aware candidate validation and terminal setup
activation ownership. The session reviewer had no open finding, and the
approved Spec and Plan remained byte-unchanged.

### Formal tests-only RED

- The exact pre-change `src` tree was
  `7aeac1f0fde0e27d126d45db064830bebb5198b9`.
- After adding both production-real regression tests and before editing
  production, `git diff HEAD -- src` remained empty with SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Formal result: 2 tests, 0 passed, 2 failed, 0 skipped:
  - `persisted saved candidate permit validates under existing real config ownership and commits one exact tuple`
  - `setup postpublication abort waits for exact activation terminal reconciliation without cancellation`
- The first test exercised both saved-slot and environment permits through a
  real atomic config writer plus `ProviderStateStore` backed by production
  `persistProviderSetupState`; both failed through the nested config writer.
- The second used the real activation coordinator, setup orchestrator, default
  runtime, atomic writer, session, and a post-rename `config-readback` pause. It
  observed one forbidden cancellation call before the terminal activation.

### Central correction

- Candidate authority now has a lock-aware snapshot-validation path for the
  already-held Runtime -> Provider -> Config order. It validates the private
  WeakMap permit, actual candidate fingerprint, exact state revision,
  connection binding/pointer/source, and current saved-slot or environment
  secret against the already-read authoritative `beforeSave.state`. It never
  invokes `ProviderStateStore.commit`, reacquires Provider, or re-enters the
  config writer.
- Once setup invokes `activateCandidate`, it awaits that exact terminal promise
  rather than racing it with an outer abort wrapper. A prepublication abort is
  therefore classified only after coordinator cleanup; an exact committed
  activation returns ready without starting cancellation CAS or emitting late
  notice/Cross UI.
- Default runtime adopts the exact committed Config/State/Runtime route into
  Config and Session when activation itself settles after interruption and the
  setup/process generations plus durable default route remain exact. This
  exception is deliberately narrower than a general aborted setup: a later
  abort during Cross-role publication retains the existing no-session-publish
  fence.

### Final verification and freeze

- New Round-2 matrix: 2/2 passed, 0 failed, 0 skipped.
- Original Integrated Round-1 matrix: 11/11 passed, 0 failed, 0 skipped.
- Provider state/authority/activation/setup/UI, serial: 306/306 passed (the
  prior 305-test block plus one new test), 0 failed, 0 skipped.
- CLI/commands/session, serial: 218/218 passed (the prior 217-test block plus
  one new test), 0 failed, 0 skipped.
- TUI/provider PTY/provider privacy, serial: 98/98 passed, 0 failed, 0 skipped.
- Integration focus: 30/30 passed, 0 failed, 0 skipped.
- Provider privacy standalone: 3/3 passed, 0 failed, 0 skipped.
- `npx tsc -p tsconfig.json --noEmit`: PASS.
- `npx tsc -p tsconfig.tests.json --noEmit`: PASS.
- `node --import tsx scripts/render-command-docs.ts --check`: PASS.
- `git diff --check`: PASS.
- Approved Spec SHA-256 remained
  `e15d19821fafbac1f0fc21dd82702d41efa481a12bdcee97df238de2ee85f021`.
- Approved Plan SHA-256 remained
  `74914bc2e38c1ac7bb8b57dbfa0abfb1963d4da7acc3fbb6868434039ce22b2c`.
- Final pre-commit `git diff HEAD -- src tests` SHA-256:
  `e6c59d5a50dec882361b0aaa3790358052d158407729aac44e757c692ce79b6c`.
- Final pre-commit `git diff HEAD -- src` SHA-256:
  `3dff2563419eaf09f702a697927d17913560a5183bdd51441930ad2bf316f6f6`.

Files changed by this round:

- `src/cli.ts`
- `src/provider-activation.ts`
- `src/provider-authority.ts`
- `src/setup-ui.ts`
- `tests/cli.test.ts`
- `tests/provider-activation.test.ts`
- this report

No global/full `npm test` was run, per the integrated-review constraint.
