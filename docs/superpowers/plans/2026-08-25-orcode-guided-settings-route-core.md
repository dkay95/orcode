# Orcode Guided Settings and Route Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an owner-only `/settings` command that opens a guided, full-screen settings surface inside the current terminal, saves each confirmed change immediately and safely, returns to the unchanged chat with `Esc`, and applies the approved Route Core identity to start, Settings, chat header, README, and the npm package.

**Architecture:** A pure settings registry projects six categories from a secretless authoritative snapshot. A controller owns navigation, search, editor requests, immediate config CAS, focus restoration, and typed runtime actions. `TerminalUi` gets a top-level `chat | settings` surface independent from its nested picker/secret/confirmation modes, while one sequential session loop prevents overlapping intents. Simple settings use an exact raw-byte config snapshot transaction; provider, account, route, model, approval-rule, and catalogue actions go through typed existing authorities. Route/model publication is upgraded to one journaled high-level transition so config, session preference, exact route, and runtime cannot be left half-switched.

**Tech Stack:** Node.js 22, TypeScript 5.9, `node:test`, existing ANSI frame/TUI renderer, SGR mouse protocol, Inquirer only at existing plain/setup boundaries, existing provider/runtime authority, `PrivateStore`, atomic config writer, SVG asset.

**Spec:** `docs/superpowers/specs/2026-08-25-orcode-guided-settings-route-core-design.md`

## Global Constraints

- `/settings` is canonical and has no alias in this release. Do not invent `/prefs`, `/config-ui`, or another alias merely to satisfy an alias test; prove instead that the shared catalogue exposes the canonical token and leaves unrelated aliases unchanged.
- The command is available only when `deriveProviderExecutionMode()` returns `local-interactive-owner` and both stdin/stdout are TTYs. JSON, piped, prompt/batch, scheduled, relay, collaborator, shared-service, multi-user, and trusted-downgrade modes reject before config snapshots, credentials, provider state, filesystem mutation, or network access.
- The fixed unavailable result is `settings-interactive-required` with secretless guidance. Do not open a raw config editor or silently fall back to line prompts.
- Settings is a full-screen surface in the same terminal. It is not a second macOS Terminal window, native window, browser page, or HTTP server. Plain interactive mode may temporarily enter the alternate screen and must restore it before the next prompt.
- Opening, rendering, navigating, searching, cancelling, resizing, suspending, and closing produce zero config, provider, credential, route, session, or network effects.
- Every visible row is either functional or explicitly read-only/disabled. There are no placeholder or Coming-soon controls. A provider descriptor whose real maturity is `coming-soon` may appear only as safe read-only status, never as an enabled action.
- Settings projections never contain raw secrets, key fragments, account IDs, account fingerprints or suffixes, request IDs, headers, cookies, provider bodies, or private storage paths. In particular, do not pass `ProviderCommandStatusEntry.accountFingerprintSuffix` into the Settings registry or view model.
- Simple changes use clone -> validate -> exact-snapshot CAS -> durable readback -> mutate the existing shared live config object. Never replace `context.config`, because the agent/provider runtime retain references to it.
- Keep top-level config schema version `1`; `appearance` is an additive validated field. Future/corrupt config and future/corrupt provider state remain read-only and must not be normalized by Settings.
- Existing slash handlers currently mutate `context.config` before saving. Settings must not call them recursively or copy that failure mode. Use typed actions and publish live state only after durable success.
- Main-model selection remains one exact backend/account/billing/requested/canonical route transition. No partial config-only model change, cross-account fallback, or implicit provider switch is allowed.
- When the runtime activity snapshot is busy, all provider-, route-, model-, approval-, tool-, and budget-affecting rows remain visible but disabled with exactly `Lauf aktiv`. Reading Settings must not acquire a runtime lease.
- Provider setup/credential input stays inside existing hidden setup primitives. A Settings-aware setup presenter must report inside Settings and must not append setup notices to the saved chat.
- Existing `ORCODE_ASCII=1` and `ROUTERCODE_ASCII=1` force ASCII over persisted preference. `NO_COLOR` changes color only. It must not change logo geometry or visibility.
- The canonical logo geometry is the approved Route Core: open hexagonal core, one connector, filled upper-right endpoint, outlined lower-right endpoint. No animation, splash delay, sound, remote font, embedded raster, or provider logo.
- Automated tests use temporary config/app homes, fake clocks, fake providers, fake credentials, fake catalogues, and fake TTYs. No live Kimi/OpenRouter/Anthropic request or real credential access is authorized.
- Preserve the current `0.7.0` version. This feature does not authorize a tag, push, npm publish, release, or Stable promotion.
- Run package/release gates serially because packaging creates transient artifacts. Preserve `.superpowers/brainstorm/` and unrelated user changes.

## File Structure

**Create**

- `src/branding.ts` — pure Route Core Unicode/ASCII terminal forms and glyph-mode resolution.
- `src/settings-registry.ts` — stable categories/items, editor descriptors, secretless snapshot projection, and search.
- `src/settings-controller.ts` — session state machine, config actions, external typed actions, refresh, conflict handling, and focus restoration.
- `src/settings-session.ts` — sequential controller/surface event loop and shared surface contracts.
- `src/model-preference-transaction.ts` — private journal and recovery for all-old/all-new model/config/session/route transitions.
- `src/ui/settings-frame.ts` — pure full-screen two-column renderer and mouse hit map.
- `assets/route-core.svg` — canonical transparent Route Core vector asset.
- `tests/branding.test.ts`
- `tests/settings-registry.test.ts`
- `tests/settings-controller.test.ts`
- `tests/settings-command.test.ts`
- `tests/settings-tui.test.ts`

**Modify**

- `src/config.ts` — appearance contract, exact editor snapshot parser/CAS, additive defaults, and validators.
- `src/config-file.ts` — exact raw-byte snapshot comparison helper.
- `src/command-catalog.ts` — canonical `/settings` entry.
- `src/commands.ts` — typed `SettingsCommandPort`, fixed unavailable result, and settings dispatch.
- `src/cli.ts` — owner/TTY gate, safe snapshot/action adapters, transactional model route, activity projection, dashboard and temporary plain-TUI wiring.
- `src/rules.ts` — durable-before-live rule removal and workspace `forgetAll` operation.
- `src/session.ts` — exact session edit snapshots/candidates used by the journaled model transition.
- `src/tui.ts` — independent Settings surface, nested editor return stack, mutable glyph presentation, input buffers, hit testing, and balanced cleanup.
- `src/ui/dashboard-frame.ts` — branding input for the empty/start view; keep chat interaction modes separate.
- `src/ui/render-frame.ts` — optional compact Route Core header segment at lower priority than route/security state.
- `src/setup-ui.ts` — Settings-aware provider setup presentation without chat writes.
- `package.json` — include `assets` in the published file set.
- `scripts/check-package.mjs` — require the canonical SVG in exact package contents.
- `README.md` — logo, Settings guide, owner-only boundary, security, ASCII behavior, and regenerated command table.
- `CHANGELOG.md` — unreleased Settings and branding entries without release claims.
- `tests/config.test.ts`
- `tests/app-home-migration.test.ts`
- `tests/rules.test.ts`
- `tests/commands-catalog.test.ts`
- `tests/commands.test.ts`
- `tests/cli.test.ts`
- `tests/integration.test.ts`
- `tests/session.test.ts`
- `tests/ui-theme.test.ts`
- `tests/ui-compose.test.ts`
- `tests/cli-entrypoint.test.ts`
- `tests/pty-release.test.ts`
- `tests/fixtures/pty-harness.mjs`
- `scripts/check-pty.mjs`

---

### Task 1: Add Appearance Defaults and Exact Config Snapshot CAS

**Files:**

- Modify: `src/config-file.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/app-home-migration.test.ts`

**Interfaces:**

Add the appearance contract in `src/config.ts`, following the repository's additive `OrcodeConfigWithBudget` pattern rather than changing `src/types.ts`:

```ts
export const GLYPH_MODES = ["auto", "unicode", "ascii"] as const;
export type GlyphMode = (typeof GLYPH_MODES)[number];

export interface AppearanceConfig {
  showLargeLogo: boolean;
  showHeaderMark: boolean;
  glyphMode: GlyphMode;
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  showLargeLogo: true,
  showHeaderMark: true,
  glyphMode: "auto",
};
```

Add `appearance: AppearanceConfig` to `OrcodeConfigWithBudget`, `appearance?: unknown` to `ConfigInput`, and `validateAppearance(value: unknown): AppearanceConfig`. Missing fields inherit their individual defaults; malformed values must not erase valid siblings.

Expose a generic exact editor transaction rather than a Settings-named storage primitive:

```ts
export interface ConfigEditSnapshot {
  readonly config: OrcodeConfigWithBudget;
  readonly file: ConfigFileSnapshot;
}

export class ConfigEditConflictError extends Error {
  readonly code = "config-edit-conflict" as const;
}

export class ConfigEditUnavailableError extends Error {
  readonly code = "config-edit-unavailable" as const;
}

export async function readConfigEditSnapshot(
  path?: string,
): Promise<ConfigEditSnapshot>;

export async function saveConfigEdit(
  expected: ConfigEditSnapshot,
  candidate: ConfigInput,
  path?: string,
): Promise<OrcodeConfigWithBudget>;

export async function saveConfigEditUnderLock(
  ownership: ConfigWriteOwnership,
  expected: ConfigEditSnapshot,
  candidate: ConfigInput,
): Promise<OrcodeConfigWithBudget>;
```

`readConfigEditSnapshot` parses the exact `ConfigFileSnapshot.raw` it returns; it must not call `loadConfigDetailed()` and then take a second unrelated snapshot. Absent config produces defaults plus the exact absent snapshot. Corrupt, unreadable, future-version, or non-persistable provider state throws `ConfigEditUnavailableError` without backup/write/migration. The caller still opens a read-only Settings view from the already-loaded safe runtime projection and disables every mutating row with `Konfiguration schreibgeschützt`.

`saveConfigEdit` validates the complete candidate, acquires `withConfigWriteLock`, and delegates to `saveConfigEditUnderLock`. The under-lock primitive verifies the supplied ownership, re-reads the target, compares kind, parent identity, file identity, and exact raw bytes to `expected.file`, refuses unsafe current state, writes atomically, verifies exact readback, and returns the frozen validated value. It never acquires a nested lock and does not mutate caller-owned objects. For `expected.file.kind === "absent"`, it must use the existing create-only `writeFileAtomicCreateSecure()` path; for an existing file it uses `writeFileAtomicSecure()` with a final exact raw-byte fence immediately before publication. A concurrent creation can never be replaced.

Add to `src/config-file.ts`:

```ts
export function sameConfigFileSnapshot(
  left: ConfigFileSnapshot,
  right: ConfigFileSnapshot,
): boolean;
```

The helper compares absence/parent identity or file dev/inode/parent/raw bytes. Existing `assertConfigFileSnapshot()` remains the pre-publication identity check; the CAS performs the stronger raw-byte comparison before publication.

- [ ] **Step 1: Write failing appearance and CAS tests**

Cover all of these literal cases:

```ts
assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG } as ConfigInput).appearance, {
  showLargeLogo: true,
  showHeaderMark: true,
  glyphMode: "auto",
});

assert.deepEqual(validateAppearance({
  showLargeLogo: false,
  showHeaderMark: false,
  glyphMode: "ascii",
}), {
  showLargeLogo: false,
  showHeaderMark: false,
  glyphMode: "ascii",
});
```

Also prove:

- valid appearance round-trips through save/load;
- a current schema-v1 file without `appearance` reads with additive defaults and `migrateAppHome()` preserves those effective defaults;
- absent-snapshot creation succeeds once;
- a second process creating the formerly absent target between snapshot and publish wins, while the Settings write rejects without replacement;
- a same-inode in-place byte edit after editor open is rejected as `config-edit-conflict`;
- atomic file replacement after editor open is rejected;
- a concurrent provider-state/config change is not overwritten;
- corrupt/future config is `config-edit-unavailable` and remains byte-identical;
- injected write/readback failure leaves the old file byte-identical;
- the returned config is the exact validated value and no live object was mutated.

- [ ] **Step 2: Run the focused RED suite**

```bash
node --import tsx --test tests/config.test.ts tests/app-home-migration.test.ts
```

Expected: FAIL on missing appearance fields, snapshot equality, and edit APIs.

- [ ] **Step 3: Implement the minimal additive config and CAS path**

Refactor one pure raw-snapshot parser out of `loadConfigDetailed` so normal load and edit load share validation without double-reading. Keep normal startup's current tolerant warning/default behavior; only edit loading fails closed. Do not change `saveConfig()` semantics for unrelated callers in this task.

- [ ] **Step 4: Run GREEN and mutation-sensitive checks**

```bash
node --import tsx --test tests/config.test.ts tests/app-home-migration.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

Temporarily remove the `raw` comparison, verify the same-inode stale test fails, restore it, and rerun GREEN.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config-file.ts tests/config.test.ts tests/app-home-migration.test.ts
git commit -m "feat: add transactional settings config edits"
```

---

### Task 2: Define the Pure Six-Category Settings Registry

**Files:**

- Create: `src/settings-registry.ts`
- Create: `tests/settings-registry.test.ts`

**Interfaces:**

Use stable IDs and discriminated editor types. UI labels are German; IDs are never derived from labels or array indexes.

```ts
export const SETTINGS_CATEGORY_IDS = [
  "models-reasoning",
  "providers-accounts",
  "security-approvals",
  "costs-budgets",
  "verify-tools",
  "appearance",
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORY_IDS)[number];

export type SettingsEditorDescriptor =
  | { readonly kind: "choice"; readonly actionId: SettingsActionId; readonly options: readonly SettingsChoice[] }
  | { readonly kind: "model"; readonly actionId: SettingsActionId; readonly filter: "main" | "compressor" | "panel" | "audio-input"; readonly multiple?: boolean }
  | { readonly kind: "number"; readonly actionId: SettingsActionId; readonly minimum: number; readonly maximum: number; readonly allowOff?: boolean; readonly unit?: string }
  | { readonly kind: "text"; readonly actionId: SettingsActionId; readonly valueKind: "path" | "command-list" | "provider-list" }
  | { readonly kind: "confirm"; readonly actionId: SettingsActionId; readonly destructive: boolean }
  | { readonly kind: "invoke"; readonly actionId: SettingsActionId }
  | { readonly kind: "readonly" };

export interface SettingsItem {
  readonly id: SettingsItemId;
  readonly categoryId: SettingsCategoryId;
  readonly label: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly displayValue: string;
  readonly editor: SettingsEditorDescriptor;
  /** False only for presentation-only actions such as Appearance. */
  readonly affectsActiveRun: boolean;
  readonly disabledReason?: "Lauf aktiv" | string;
}

export interface SettingsRegistry {
  readonly categories: readonly SettingsCategory[];
  readonly items: readonly SettingsItem[];
}
```

Define `SettingsActionId` as a literal union, not `string`, containing these real actions:

- models: `main-model`, `reasoning`, `compression-mode`, `compressor-model`, `max-steps`;
- providers: `provider-setup`, dynamic `provider-connect|enable|disable|disconnect|reconnect|models|logout`, `provider-sort`, `provider-data-collection`, `provider-only`, `provider-ignore`, `provider-fallback`;
- security: `approval-mode`, dynamic `approval-forget`, `approval-forget-all`, and the same typed OpenRouter privacy actions projected in this category with category-specific item IDs;
- costs: `max-cost`, `compressor-max-cost`, `budget-daily`, `budget-total`, `budget-on-exceed`;
- verify/tools: `verify-mode`, `verify-commands`, `verify-suggest`, `verify-clear`, `verify-repair-rounds`, `web-mode`, `browser-path`, `browser-timeout`, `panel-models`, `panel-judge`, `transcription-model`, `voice-consent-clear`;
- appearance: `appearance-large-logo`, `appearance-header-mark`, `appearance-glyph-mode`.

Read-only rows are `current-route`, `provider-status:<backend>`, `approval-rule:<id>`, `cost-summary`, and `voice-consent-status`. Dynamic IDs must encode only stable local IDs/backend IDs; never account identity.

The registry input is explicitly secretless:

```ts
export interface SettingsAuthoritativeSnapshot {
  readonly config: OrcodeConfigWithBudget;
  readonly runActive: boolean;
  readonly route: SettingsRouteProjection | null;
  readonly providers: readonly SettingsProviderProjection[];
  readonly approvalRules: readonly SettingsApprovalRuleProjection[];
  readonly costs: SettingsCostProjection;
  readonly cachedModels: readonly ModelInfo[];
}
```

`SettingsProviderProjection` deliberately has no account fingerprint/suffix field. It carries an exact `allowedActions: readonly ProviderBackendAction[]` derived from the same exported backend capability matrix as `/provider`: OpenRouter allows connect, enable, disable, disconnect, reconnect, models, and logout; Kimi Code allows the same set except disconnect; Anthropic is read-only Coming soon. The registry creates only actions present in that list. `SettingsCostProjection` uses `CostKnowledge`; unknown/provider-managed values render as `Kosten unbekannt · providerverwaltet`, never `$0`.

Export:

```ts
export function buildSettingsRegistry(
  snapshot: SettingsAuthoritativeSnapshot,
): SettingsRegistry;

export function searchSettings(
  registry: SettingsRegistry,
  query: string,
): readonly SettingsItem[];
```

Search normalizes case/diacritics and scores exact/prefix/contains across label, description, aliases, and `displayValue`; ordering is deterministic with registry order as the final tie-break.

- [ ] **Step 1: Write failing registry contract tests**

Assert exactly six ordered category IDs and German labels:

```ts
assert.deepEqual(registry.categories.map(({ id }) => id), SETTINGS_CATEGORY_IDS);
assert.deepEqual(registry.categories.map(({ label }) => label), [
  "Modelle & Denken",
  "Anbieter & Konten",
  "Sicherheit & Freigaben",
  "Kosten & Budgets",
  "Prüfen & Tools",
  "Darstellung",
]);
```

Test every item ID for global uniqueness and deterministic order, and every action ID against the closed `SettingsActionId` union. Action IDs may intentionally repeat when the same OpenRouter privacy setting is projected in two categories. Assert every item has a concrete nonempty description and either a real editor/action or `readonly`; reject `TODO`, `TBD`, and `placeholder` case-insensitively. A truthful `Coming soon` provider maturity value is allowed only on a read-only item with no action.

Use a deep forbidden-key/value walk proving the registry/view source contains none of:

```ts
[
  "accountFingerprint",
  "accountFingerprintSuffix",
  "credentialSlot",
  "apiKey",
  "secret",
  "requestId",
]
```

Test active-run disabling only where `affectsActiveRun` is true while read-only and Appearance rows remain enabled, current value rendering, provider-managed unknown cost, the exact OpenRouter/Kimi/Anthropic action matrix (especially no Kimi disconnect), duplicate privacy projections sharing the same action ID, and searches for `kimi`, `ASCII`, `budget`, current model ID, alias, and description text.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/settings-registry.test.ts
```

Expected: FAIL because the registry module does not exist.

- [ ] **Step 3: Implement the pure registry and exhaustive ID switches**

Use `satisfies` plus `assertNever` so a new action/category cannot silently miss a row or editor. Build dynamic provider/rule rows only from the safe projection. Do not import filesystem, credentials, provider clients, ANSI, `TerminalUi`, or `process`.

- [ ] **Step 4: Run GREEN and type-check**

```bash
node --import tsx --test tests/settings-registry.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/settings-registry.ts tests/settings-registry.test.ts
git commit -m "feat: define guided settings registry"
```

---

### Task 3: Build the Controller and Sequential Settings Session Loop

**Files:**

- Create: `src/settings-controller.ts`
- Create: `src/settings-session.ts`
- Create: `tests/settings-controller.test.ts`

**Interfaces:**

Keep navigation and mutations independent from terminal rendering:

```ts
export type SettingsIntent =
  | { readonly kind: "move"; readonly delta: -1 | 1 }
  | { readonly kind: "category"; readonly categoryId: SettingsCategoryId }
  | { readonly kind: "search-start" }
  | { readonly kind: "search-change"; readonly query: string }
  | { readonly kind: "activate" }
  | { readonly kind: "select-item"; readonly itemId: SettingsItemId }
  | { readonly kind: "back" };

export type SettingsControllerEffect =
  | { readonly kind: "render" }
  | { readonly kind: "close" }
  | { readonly kind: "edit"; readonly request: SettingsEditorRequest };

export type SettingsEditorResult =
  | { readonly kind: "cancel" }
  | { readonly kind: "value"; readonly value: string | number | boolean | readonly string[] };

export interface SettingsSnapshotPort {
  read(): Promise<SettingsControllerSnapshot>;
}

export interface SettingsExternalActionPort {
  execute(action: SettingsExternalAction): Promise<void>;
}

export interface PreparedLiveConfigPublication {
  /** Prevalidated synchronous commit; implementations MUST NOT throw. */
  publish(): void;
}

export interface SettingsLiveConfigPort {
  prepare(config: OrcodeConfigWithBudget): PreparedLiveConfigPublication;
}

export type SettingsConfigEditState =
  | { readonly kind: "editable"; readonly snapshot: ConfigEditSnapshot }
  | {
      readonly kind: "read-only";
      readonly config: OrcodeConfigWithBudget;
      readonly reason: "Konfiguration schreibgeschützt";
    };

export interface SettingsControllerDependencies {
  readonly configPath: string;
  readonly snapshots: SettingsSnapshotPort;
  readonly externalActions: SettingsExternalActionPort;
  readonly liveConfig: SettingsLiveConfigPort;
  readonly readConfig: (path: string) => Promise<ConfigEditSnapshot>;
  readonly saveConfig: (
    expected: ConfigEditSnapshot,
    candidate: ConfigInput,
    path: string,
  ) => Promise<OrcodeConfigWithBudget>;
}

export class SettingsController {
  static open(
    dependencies: SettingsControllerDependencies,
    initialCategory?: SettingsCategoryId,
  ): Promise<SettingsController>;
  get view(): SettingsViewModel;
  dispatch(intent: SettingsIntent): Promise<SettingsControllerEffect>;
  completeEditor(
    request: SettingsEditorRequest,
    result: SettingsEditorResult,
  ): Promise<SettingsControllerEffect>;
}
```

`SettingsController.open(...)` reads one safe authoritative runtime snapshot, attempts one exact `ConfigEditSnapshot`, records `SettingsConfigEditState`, and keeps the selected category/item by stable ID. A failed edit snapshot does not abort the screen: the view remains readable and all mutation rows show `Konfiguration schreibgeschützt`. `dispatch()` is pure except when it returns an editor. `completeEditor()` serializes one mutation, rechecks activity, maps values with an exhaustive action switch, and then:

- simple config action: clone config -> patch exact typed field -> validate -> prepare a no-throw live publication -> `saveConfigEdit` against the editor snapshot -> invoke the prepared publication -> refresh;
- external action: call one typed external port -> refresh config/runtime snapshots;
- conflict: set notice `Einstellung wurde parallel geändert`, refresh authoritative state, keep the row selected, require a new edit;
- invalid value: retain editor with bounded validation message and zero write;
- cancelled editor: return to the same row with zero mutation;
- success: notice `Gespeichert`, remain in Settings, restore the same item ID.

`SettingsLiveConfigPort.prepare()` validates all derived live updates before persistence and returns a synchronous `publish()` closure that is contractually no-throw. That closure mutates the existing shared config object and synchronizes every derived live owner affected by the changed field, including `ApprovalManager` and `TerminalUi.applyAppearance()`. A prepare failure occurs before disk mutation; after durable success the prepared closure cannot leave file/live state split. The production closure is an exhaustive sequence of non-throwing assignments and UI refresh scheduling, with a focused test for every config action.

Selecting permission-expanding approval mode `allow-all` does not write immediately. `completeEditor()` returns a second `confirm` editor using the existing allow-all warning copy; only an accepted confirmation produces the config action. Cancellation and an active-run race produce zero write. Other approval modes retain their current command semantics.

An invalid number/path/list/command result returns `{ kind: "edit", request: { ...sameRequest, validationMessage } }`; the sequential session loop immediately reopens that same editor with the user's sanitized input retained. It does not return to navigation, refresh snapshots, or write until the editor yields a valid value or cancel.

`voice-consent-clear` is a simple, confirmed `SettingsConfigAction` that can only set `voiceConsentGiven` to `false`. There is deliberately no Settings action that sets consent to true; only the just-in-time voice flow may grant it.

Do not use arbitrary dotted config paths. Define a literal `SettingsConfigAction` union and an exhaustive `applyConfigAction(candidate, action)` that covers each simple config field, including nested provider/budget/verify/appearance fields.

Define the surface/event pump in `src/settings-session.ts`:

```ts
export interface SettingsSurface {
  begin(view: SettingsViewModel): Promise<void> | void;
  nextIntent(view: SettingsViewModel): Promise<SettingsIntent>;
  edit(request: SettingsEditorRequest): Promise<SettingsEditorResult>;
  end(): Promise<void> | void;
}

export async function runSettingsSession(
  controller: SettingsController,
  surface: SettingsSurface,
): Promise<void>;
```

The loop invokes `surface.begin(controller.view)` once, awaits exactly one intent, then exactly one controller effect, then at most one editor per effect. `completeEditor()` may return one further effect for an explicitly bounded guided step such as allow-all confirmation; the loop handles that sequentially and never has two editors outstanding. It invokes `surface.end()` exactly once in `finally` on `Esc`, EOF, abort, surface error, or controller error.

- [ ] **Step 1: Write failing state-machine and transaction tests**

Use in-memory fakes and a temp config path to prove:

- open selects category 1/first enabled item;
- Up/Down clamp at the first/last visible row; number category selection restores that category's prior row;
- `/` search, query update, result selection, and `Esc` hierarchy return search -> category -> close;
- disabled `Lauf aktiv` items never request an editor or call an action;
- Appearance items remain editable during an active run because `affectsActiveRun` is false;
- corrupt/future config opens read-only Settings and every mutation remains disabled;
- cancel is a zero-effect round trip;
- one valid config choice calls CAS once, publishes only after it resolves, refreshes, and restores focus;
- validation/write/readback failure never publishes live config;
- stale snapshot emits the fixed German conflict, reloads, and cannot retry the old value without a fresh editor;
- external action failure preserves current projection and shows a bounded safe message;
- allow-all requests the existing warning confirmation, cancel writes nothing, confirm writes once, and a busy race writes nothing;
- invalid typed input returns the same editor with a bounded message until valid/cancel, without an intermediate navigation render;
- clearing voice consent writes `false` once, while no Settings path can write `true`;
- the session loop has at most one outstanding `nextIntent`/editor and closes exactly once under close, throw, and abort.

Add a mutation-order assertion:

```ts
assert.deepEqual(events, [
  "read-snapshot",
  "validate-candidate",
  "persist-start",
  "persist-done",
  "publish-live",
  "refresh",
]);
```

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/settings-controller.test.ts
```

Expected: FAIL on missing controller/session modules.

- [ ] **Step 3: Implement the smallest exhaustive controller**

Use immutable controller state between events. Sanitize external error messages through one fixed local mapping; never reflect arbitrary provider/storage error text into the view. Limit notices to one line and search query to 120 Unicode code points.

- [ ] **Step 4: Run GREEN and type-check**

```bash
node --import tsx --test tests/settings-controller.test.ts tests/settings-registry.test.ts tests/config.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/settings-controller.ts src/settings-session.ts tests/settings-controller.test.ts
git commit -m "feat: add settings controller state machine"
```

---

### Task 4: Add the Canonical `/settings` Command Port and Owner Gate

**Files:**

- Modify: `src/command-catalog.ts`
- Modify: `src/commands.ts`
- Create: `tests/settings-command.test.ts`
- Modify: `tests/commands-catalog.test.ts`
- Modify: `tests/commands.test.ts`
- Modify: `README.md` only through the command-doc renderer in this task

**Interfaces:**

Add one catalogue entry near `/config`:

```ts
{
  name: "settings",
  handlerId: "settings",
  usage: "/settings",
  description: "Geführte Einstellungen im Vollbild öffnen",
}
```

Add to `src/commands.ts`:

```ts
export interface SettingsCommandPort {
  open(): Promise<void>;
}

export class SettingsInteractiveRequiredError extends Error {
  readonly code = "settings-interactive-required" as const;
  constructor() {
    super(
      "settings-interactive-required · /settings ist nur im lokalen interaktiven Eigentümer-Terminal verfügbar.",
    );
    this.name = "SettingsInteractiveRequiredError";
  }
}
```

`CommandContext` gets `settings?: SettingsCommandPort`. The dispatcher branch is exactly:

```ts
case "settings":
  if (!context.settings) throw new SettingsInteractiveRequiredError();
  await context.settings.open();
  return "continue";
```

No config/provider/runtime object is touched before the port check. The CLI later decides whether to install the port; the command layer does not infer TTY/ownership itself.

- [ ] **Step 1: Write failing catalogue/dispatch/null-effect tests**

Prove:

- `resolveSlashCommand("settings")` resolves to the exact handler;
- `/settings` appears once in completion/help/generated README and has no aliases;
- one invocation calls `settings.open()` exactly once and returns `continue`;
- a missing port throws/reports the exact fixed code and German guidance above, byte-identically in every supported error renderer;
- spies for config reads/writes, credential access, provider actions, route transitions, session saves, and network remain zero when the port is absent.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/settings-command.test.ts tests/commands-catalog.test.ts tests/commands.test.ts
```

Expected: FAIL because the command and port do not exist.

- [ ] **Step 3: Implement the catalogue and command port**

Regenerate, never hand-edit, the command block:

```bash
node --import tsx scripts/render-command-docs.ts --write
```

- [ ] **Step 4: Run GREEN and prove docs determinism**

```bash
node --import tsx --test tests/settings-command.test.ts tests/commands-catalog.test.ts tests/commands.test.ts
node --import tsx scripts/render-command-docs.ts --check
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/command-catalog.ts src/commands.ts tests/settings-command.test.ts tests/commands-catalog.test.ts tests/commands.test.ts README.md
git commit -m "feat: add owner settings command port"
```

---

### Task 5: Build Typed Runtime Actions and Transactional Model/Rule Publication

**Files:**

- Create: `src/model-preference-transaction.ts`
- Modify: `src/settings-controller.ts`
- Modify: `src/commands.ts`
- Modify: `src/cli.ts`
- Modify: `src/rules.ts`
- Modify: `src/session.ts`
- Modify: `src/setup-ui.ts`
- Modify: `tests/rules.test.ts`
- Modify: `tests/session.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/integration.test.ts`
- Modify: `tests/settings-controller.test.ts`

**Interfaces:**

The controller's external union is explicit:

```ts
export type SettingsExternalAction =
  | { readonly kind: "provider"; readonly intent: ProviderCommandIntent }
  | { readonly kind: "main-model"; readonly requestedModelId: string; readonly canonicalModelId: string }
  | { readonly kind: "compressor-model"; readonly modelId: string }
  | { readonly kind: "approval-forget"; readonly ruleId: string }
  | { readonly kind: "approval-forget-all" }
  | { readonly kind: "verify-suggest" }
  | { readonly kind: "panel-models"; readonly modelIds: readonly string[] }
  | { readonly kind: "transcription-model"; readonly modelId: string };
```

Export the backend lifecycle capability matrix from `src/commands.ts` as the one authority used by both slash parsing and the safe Settings snapshot:

```ts
export const PROVIDER_BACKEND_ACTIONS: Readonly<
  Record<ProviderCommandBackendId, ReadonlySet<ProviderBackendAction>>
>;

export function providerBackendActions(
  backendId: ProviderCommandBackendId,
): readonly ProviderBackendAction[];
```

The values stay byte-for-byte compatible with the existing parser: OpenRouter has connect/enable/disable/disconnect/reconnect/models/logout; Kimi omits disconnect; Anthropic descriptors remain Coming soon and the Settings projection exposes no mutating action despite the parser's future structural set.

Simple provider sort/privacy/list/fallback settings remain config actions because they are validated in `src/config.ts`; provider setup/lifecycle/catalogue calls use `ProviderCommandIntentPort.execute()` directly. Confirmation-required provider results must be passed through the existing confirmation token flow; do not synthesize a second token or bypass the provider authority.

Add a safe cached projection that explicitly maps allowed fields:

```ts
export interface SettingsRuntimeSnapshotPort {
  readCached(): SettingsRuntimeProjection;
}

export interface ProviderRuntimeActivity {
  readonly runActive: boolean;
  readonly activationHeld: boolean;
}
```

`SessionProviderRuntimeGuard.activity()` returns counters as booleans without acquiring a lease. The Settings adapter maps provider state/config/session/cost/rules synchronously and omits `accountFingerprintSuffix` and all credential identifiers. Loading or rendering the snapshot must perform zero provider command execution, keychain calls, environment credential reads, or network calls.

Upgrade model transition to a high-level callback boundary:

```ts
export interface SessionModelPreferenceCandidate {
  readonly requestedModelId: string;
  readonly canonicalModelId: string;
}

export interface SessionModelPublication {
  persist(route: RouteIdentityV1): Promise<void>;
  publish(route: RouteIdentityV1): void;
}

export interface ProviderRouteIntentPort {
  // existing methods remain
  transitionSessionModel?(
    candidate: SessionModelPreferenceCandidate,
    publication: SessionModelPublication,
    surface?: SetupSurface | "plain" | "fullscreen",
  ): Promise<RouteIdentityV1>;
}
```

`DefaultProviderRuntime.transitionSessionModel` owns the runtime lease, stages and proves the exact route, calls `publication.persist(route)` before publishing runtime/live/session state, then calls `publication.publish(route)` exactly once. Internal OpenRouter/Kimi transition paths must delay adoption until persistence succeeds. If preparation or persistence fails, cancel/recover the staged provider activation and retain the prior route/runtime/session/config. If provider durable state can commit before a later local failure, use the existing activation journal/adoption machinery to converge to one complete old or new tuple; never guess from an in-memory success flag.

The Settings publication callback:

1. builds the complete candidate config with `mainModel` and the exact returned route's requested model;
2. prepares a cloned session preference with requested model, current reasoning, and exact route;
3. writes the config via `saveConfigEditUnderLock` and an exact session candidate under the recoverable transition record defined below;
4. verifies both readbacks;
5. only then mutates the shared config object/session owner in `publish`.

Route fields compared in every proof are version, backend ID, account fingerprint, billing realm, requested model, canonical model, and resolution state. The fingerprint is used only inside the authority and never crosses into Settings view data.

Create a concrete private journal in `src/model-preference-transaction.ts`:

```ts
export const MODEL_PREFERENCE_TRANSACTION_VERSION = 1 as const;

export type ModelPreferencePhase =
  | "prepared"
  | "preferences-durable"
  | "route-durable"
  | "committed";

export interface ModelPreferenceTransactionV1 {
  readonly version: 1;
  readonly transactionId: string;
  readonly phase: ModelPreferencePhase;
  readonly configPath: string;
  readonly sessionPath: string;
  readonly before: ModelPreferenceDurableTuple;
  readonly after: ModelPreferenceDurableTuple;
}
```

Journals live as one private, create-only file per UUID under `<appHome>/transactions/model-preference/`. `ModelPreferenceDurableTuple` stores exact before/after config and session bytes plus the exact old/new route; it contains no credential. The directory and journal use `PrivateStore` identity/mode checks and bounded file sizes. Add `readSessionEditSnapshot()` and `saveSessionEditUnderLock(ownership, expected, candidate)` in `src/session.ts`, analogous to the config APIs; they never acquire nested locks or mutate the live `SessionStore` before verified readback. The transaction calls `withConfigWriteLocks([configPath, sessionPath], ...)` once and passes the two returned ownership proofs to the under-lock publishers.

The only lock order is provider coordinator/runtime lease -> sorted config/session writer locks -> journal file claim. No code may acquire those in reverse order. The transaction protocol is:

1. acquire the runtime lease and stage/prove the new provider route without publishing it;
2. acquire sorted config/session writer ownership and capture exact old snapshots;
3. create the `prepared` journal with complete old/new bytes and exact routes;
4. publish/verify new config and session bytes, then advance journal to `preferences-durable`;
5. durably commit the exact provider route through the existing provider activation journal, then advance to `route-durable`;
6. invoke the already-prepared no-throw live publication and runtime/session adoption;
7. mark `committed`, verify the authoritative tuple, and remove the journal.

On any handled failure before step 5, restore and verify both old config/session bytes while locks and the runtime lease are held, cancel the staged route, then remove the journal. Once the provider route may have committed, determine the outcome from the authoritative provider state and its existing activation journal: exact new route means roll forward both new byte snapshots; otherwise roll back both old snapshots. Never decide from an in-memory boolean. Crash/startup recovery scans bounded journal files after app-home migration but before provider startup/session adoption, acquires the same locks in the same order, converges each record to wholly old or wholly new, publishes no UI/runtime state during recovery, and quarantines malformed/future journals without rewriting config/session/provider state.

Make `RuleStore` durable-before-live:

```ts
async forget(id: string): Promise<boolean>;
async forgetAll(workspace: string): Promise<number>;
```

Both methods construct a candidate list, persist it, then assign `#rules`. A persistence failure leaves `list()` byte-for-byte equivalent. Preserve slash-command confirmation semantics exactly; Settings must not invent broader authority.

Add `createSettingsSetupSurface(...)` in `src/setup-ui.ts`. It reuses model/choice/secret/confirm primitives but routes status/notices to the Settings controller. It never calls `ui.addMessage`, never exposes a secret, and restores Settings after the setup flow.

- [ ] **Step 1: Write failing route, action, privacy, and rule tests**

Cover failpoints before/after journal creation, provider preparation, config CAS, session write/readback, preferences phase update, durable provider commit, route phase update, live publication, committed phase, and journal removal. At each failure run the explicit recovery entry point and assert the authoritative tuple is wholly old or wholly new, never mixed:

```ts
assert.deepEqual(currentTuple(), {
  configModel: old.requestedModelId,
  sessionRoute: old,
  runtimeRoute: old,
  providerDefaultRoute: old,
});
```

Then assert the successful tuple uses the same exact new route in all four owners. Add OpenRouter and Kimi fixtures and a stale account/revision case.

Also prove:

- cached Settings snapshot makes zero credential/network calls and contains no forbidden identity keys;
- the exported action matrix is the single source for parser and projection, with no Kimi disconnect and no actionable Anthropic row;
- activity read does not acquire a lease;
- provider destructive confirmation uses the real token and exact backend;
- setup cancellation changes neither chat nor config;
- failed `RuleStore.forget`/`forgetAll` leaves in-memory rules unchanged;
- compressor/panel/audio choices use the existing capability validators;
- unsupported Kimi compressor/panel/audio actions stay disabled with the existing safe explanation.

- [ ] **Step 2: Run focused RED suites**

```bash
node --import tsx --test tests/rules.test.ts tests/session.test.ts tests/integration.test.ts tests/cli.test.ts tests/settings-controller.test.ts
```

Expected: FAIL on the missing transactional port, activity projection, safe adapter, and durable rule removal.

- [ ] **Step 3: Implement the smallest typed adapters and publication protocol**

Extract shared domain functions from private slash handlers only where both callers need them. Keep text parsing/rendering in `commands.ts`; typed Settings actions must never call `handleSlashCommand` with synthetic strings. Do not add a second provider coordinator or lock.

- [ ] **Step 4: Run GREEN plus provider authority regressions**

```bash
node --import tsx --test tests/rules.test.ts tests/session.test.ts tests/integration.test.ts tests/cli.test.ts tests/settings-controller.test.ts tests/provider-authority.test.ts tests/provider-activation.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

Temporarily publish the live config before persistence and verify the ordering/failpoint test fails; restore and rerun GREEN.

- [ ] **Step 5: Commit**

```bash
git add src/model-preference-transaction.ts src/settings-controller.ts src/commands.ts src/cli.ts src/rules.ts src/session.ts src/setup-ui.ts tests/rules.test.ts tests/session.test.ts tests/cli.test.ts tests/integration.test.ts tests/settings-controller.test.ts
git commit -m "feat: add transactional settings action adapters"
```

---

### Task 6: Add Route Core Branding and the Pure Settings Frame

**Files:**

- Create: `src/branding.ts`
- Create: `assets/route-core.svg`
- Create: `src/ui/settings-frame.ts`
- Create: `tests/branding.test.ts`
- Create: `tests/settings-tui.test.ts`
- Modify: `tests/ui-theme.test.ts`

**Interfaces:**

The SVG uses the approved geometry from the selected visual direction and no external dependency:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" role="img" aria-labelledby="title desc">
  <title id="title">orcode Route Core</title>
  <desc id="desc">Open routing core connected to a filled and an outlined endpoint</desc>
  <path d="M9 14h13l6 10-6 10H9L3 24l6-10Z" fill="none" stroke="currentColor" stroke-width="3"/>
  <path d="M25 24h4m0 0 3-6m-3 6 3 6" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
  <circle cx="35" cy="14" r="5" fill="currentColor"/>
  <circle cx="35" cy="34" r="5" fill="none" stroke="currentColor" stroke-width="3"/>
</svg>
```

`src/branding.ts` owns all terminal representations:

```ts
export type ResolvedGlyphMode = "unicode" | "ascii";

export interface GlyphEnvironment {
  readonly ORCODE_ASCII?: string;
  readonly ROUTERCODE_ASCII?: string;
  readonly LANG?: string;
  readonly LC_ALL?: string;
}

export function resolveGlyphMode(
  preference: GlyphMode,
  env: GlyphEnvironment,
): ResolvedGlyphMode;

export function routeCoreLarge(mode: ResolvedGlyphMode): readonly string[];
export function routeCoreCompact(mode: ResolvedGlyphMode): string;
export const ROUTE_CORE_WORDMARK = "ORCODE";
```

Hard-code these reviewed Unicode and ASCII line arrays; do not derive terminal art from the SVG:

```ts
const UNICODE_ROUTE_CORE_LARGE = [
  "    ╭────────╮         ●",
  "  ╱            ╲      ╱",
  " ╱      ◇       ├────┤",
  "  ╲            ╱      ╲",
  "    ╰────────╯         ○",
  "          ORCODE",
] as const;

const ASCII_ROUTE_CORE_LARGE = [
  "    /--------\\         *",
  "  /            \\      /",
  " <       o       +----+",
  "  \\            /      \\",
  "    \\--------/         o",
  "          ORCODE",
] as const;

const UNICODE_ROUTE_CORE_COMPACT = "⬡─┤●○";
const ASCII_ROUTE_CORE_COMPACT = "<>-+*o";
```

Both snapshots show the outlined routing core, connector, one filled/solid endpoint, one open endpoint, and `ORCODE`. `resolveGlyphMode` gives either ASCII env override precedence, then explicit persisted choice, then conservative locale auto-detection.

`src/ui/settings-frame.ts` consumes only a view model, theme, dimensions, and resolved brand:

```ts
export interface SettingsFrameInput {
  readonly width: number;
  readonly height: number;
  readonly theme: Theme;
  readonly view: SettingsViewModel;
  readonly brand: { readonly large: readonly string[]; readonly compact: string; readonly visible: boolean };
}

export interface SettingsHitTarget {
  readonly row: number;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly intent: SettingsIntent;
}

export interface SettingsFrameResult {
  readonly frame: Frame;
  readonly hitTargets: readonly SettingsHitTarget[];
}

export function buildSettingsFrame(input: SettingsFrameInput): SettingsFrameResult;
```

Layout contract:

- title/Route Core area at top when enabled and height permits;
- left category column with `1` through `6`, right item/value/description column;
- selected item and disabled reason remain visible without color;
- search query/results replace the normal item list while retaining title/context;
- footer always states `↑↓ wählen · Enter ändern · / suchen · Esc zurück` or the nested/search-specific equivalent;
- width below the two-column threshold stacks category then item list; width/height below renderer minimum produces a bounded resize message, never broken ANSI or an exception;
- hit targets are derived during render and contain no application callbacks.

- [ ] **Step 1: Write failing branding and pure-frame snapshots**

Assert exact Unicode/ASCII line arrays, compact marks, env override precedence, explicit mode, locale auto fallback, and that `NO_COLOR` output retains identical plain-text geometry. Parse the SVG as text and assert one core path, one branching connector path that reaches both endpoint boundaries, one filled circle, one outlined circle, a 48x48 viewBox, no `href`, external stylesheet/font, image, script, or embedded data URI. The standard SVG namespace URI is required and is not treated as an external resource.

Render representative 120x36, 80x24, 50x16, and 39x7 frames. Assert category/item selection, values, disabled `Lauf aktiv`, search, error/success notice, footer, no overflow by `displayWidth`, and hit targets pointing only to visible rows.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/branding.test.ts tests/settings-tui.test.ts tests/ui-theme.test.ts
```

Expected: FAIL because branding and settings frame modules do not exist.

- [ ] **Step 3: Implement pure branding and layout**

Use existing `span`, `composeLine`, `displayWidth`, `Theme`, and `Frame` primitives. ANSI remains exclusively in the existing render pipeline. Never count JavaScript string length as terminal width.

- [ ] **Step 4: Run GREEN and deterministic snapshot checks**

```bash
node --import tsx --test tests/branding.test.ts tests/settings-tui.test.ts tests/ui-theme.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/branding.ts assets/route-core.svg src/ui/settings-frame.ts tests/branding.test.ts tests/settings-tui.test.ts tests/ui-theme.test.ts
git commit -m "feat: add route core settings presentation"
```

---

### Task 7: Give TerminalUi a Dedicated Settings Surface

**Files:**

- Modify: `src/tui.ts`
- Modify: `src/ui/dashboard-frame.ts`
- Modify: `tests/tui.test.ts`
- Modify: `tests/settings-tui.test.ts`

**Interfaces:**

Do not flatten Settings into the existing `UiMode`. Split top-level surface from nested interaction:

```ts
type UiSurface = "chat" | "settings";

export class TerminalUi implements SettingsSurface {
  begin(view: SettingsViewModel): void;
  nextIntent(view: SettingsViewModel): Promise<SettingsIntent>;
  edit(request: SettingsEditorRequest): Promise<SettingsEditorResult>;
  end(): void;
  applyAppearance(appearance: AppearanceConfig): void;
}
```

Keep existing `UiMode` for chat/editor modes and add only the generic validated text/number editor mode needed by Settings. Store independent buffers:

```ts
#surface: UiSurface = "chat";
#settingsView: SettingsViewModel | null = null;
#settingsIntentResolve: ((intent: SettingsIntent) => void) | null = null;
#settingsSearchChars: string[] = [];
#editorChars: string[] = [];
#returnSurface: UiSurface | null = null;
```

Never reuse `#inputChars` for Settings search or nested editors. Therefore chat draft/cursor/history/suggestions/attachments/view-model/viewport/scroll/run snapshot remain untouched without copying or reloading turns.

`frame()` calls `buildSettingsFrame()` when `#surface === "settings"`; otherwise it calls `buildDashboardFrame()` unchanged. Key routing order is global terminal cleanup/Ctrl+C/paste framing -> active nested editor -> Settings surface -> chat behavior.

Settings keys:

- `Up`/`Down`: one move intent;
- `1`-`6`: exact category intent;
- `/`: enter search; typed text/backspace updates search through one intent at a time;
- `Enter`: activate selected row;
- `Esc`: one back intent; the controller decides search/category/close hierarchy;
- SGR left click: use the last `SettingsHitTarget`, emit its intent; reject release, other button, malformed, stale, or out-of-range sequences.

Nested `pickModel`, `pickChoice`, hidden secret, confirmation, and new validated input methods save `#returnSurface = "settings"`; settlement returns to Settings rather than unconditional `busy` chat. Provider secret input remains masked and is cleared on settle/stop.

Mouse ownership is active for Settings and model/choice pickers only. `start`, `suspend`, resume, editor settlement, `end`, `stop`, `dispose`, signals, EOF, and fatal cleanup enable/disable it in balanced pairs. Expand stop settlement so every picker, confirmation, recording, validated editor, and Settings intent resolves/cancels exactly once.

`applyAppearance()` resolves glyph mode with the persisted value plus hard env overrides, rebuilds the theme without changing Chalk's `NO_COLOR` detection, refreshes the frame, and is safe while Settings is visible. Preserve compatibility for tests/callers injecting an explicit theme by adding a theme factory seam rather than silently ignoring their theme.

- [ ] **Step 1: Extend failing TUI behavior tests**

Add fake-TTY tests for:

- keyboard and SGR mouse selecting the same Settings row;
- category number shortcuts and search editing without changing chat draft;
- nested choice/model/text/confirm cancel returns to Settings and the same row;
- final `Esc` returns to byte-equivalent draft, cursor, attachments, viewport, selected chat, and route state;
- `loadTurns` is never called during the round trip;
- resize/narrow fallback while Settings is open;
- suspend/resume re-enables mouse once, close/stop disables once;
- stop/signal/EOF settles every pending primitive once;
- malformed/split mouse frames never leak bytes into Settings search or chat input;
- glyph preference changes live, while env ASCII override remains dominant.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/settings-tui.test.ts tests/tui.test.ts
```

Expected: FAIL on the missing Settings surface and independent buffers.

- [ ] **Step 3: Implement surface separation and balanced lifecycle**

Keep the sequential `nextIntent()` contract: resolving an arrow key does not close Settings; `runSettingsSession` immediately presents the next immutable view. Refuse a second outstanding Settings intent promise as a programming error and fail closed back to chat.

- [ ] **Step 4: Run GREEN and existing UI regressions**

```bash
node --import tsx --test tests/settings-tui.test.ts tests/tui.test.ts tests/ui-compose.test.ts tests/ui-render-block.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

Temporarily point Settings search at `#inputChars`, verify the draft-preservation test fails, restore, and rerun GREEN.

- [ ] **Step 5: Commit**

```bash
git add src/tui.ts src/ui/dashboard-frame.ts tests/tui.test.ts tests/settings-tui.test.ts
git commit -m "feat: add fullscreen settings tui surface"
```

---

### Task 8: Wire Settings into Dashboard and Plain Interactive CLI

**Files:**

- Modify: `src/cli.ts`
- Modify: `src/setup-ui.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/integration.test.ts`
- Modify: `tests/settings-command.test.ts`

**Interfaces:**

Create one CLI factory whose first operation is the execution gate:

```ts
export interface SettingsCommandPortInput {
  readonly executionMode: ProviderExecutionMode;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly createSession: () => Promise<SettingsSessionDependencies>;
}

export function createSettingsCommandPort(
  input: SettingsCommandPortInput,
): SettingsCommandPort | undefined;
```

If mode/TTY is not exact, return `undefined` without calling `createSession`. For dashboard, `createSession` reuses the active `TerminalUi`. For plain interactive, it creates a temporary `TerminalUi`, starts the alternate screen only after the line prompt has settled, runs the same controller/session/surface, and stops it in `finally` before Inquirer asks for another line.

Build the safe snapshot from the already-loaded shared config, exact config edit snapshot, current session, `RuleStore.list(workspace)`, cached provider state, cached model data, activity projection, and existing spend tracker. Do not call `providerCommands.execute({kind: "status"})` if that path can inspect credentials; use the explicit cached safe mapper added in Task 5.

Wire editor kinds:

- main/compressor/panel/audio model requests use existing catalogue ranking and capability filters;
- choice requests use `TerminalUi.pickChoice`;
- number/path/command/provider-list requests use the validated editor and the same bounds/validators as config/verify commands;
- provider setup uses the Settings-aware setup surface;
- provider confirmation uses existing `confirmProviderMutation` semantics and confirmation tokens;
- secret input never crosses the provider setup boundary.

The active-run check occurs both when constructing the view and immediately before external/config mutation. A race from idle to busy returns `Lauf aktiv`, refreshes, and makes no mutation.

- [ ] **Step 1: Write failing execution-mode and end-to-end adapter tests**

Table-test every `ProviderExecutionMode` and TTY combination. For all rejected cases assert `createSession`, config read/write, rules read, credential access, provider action, route action, session save, and network spies remain zero.

For dashboard and plain interactive owner fixtures, run:

```text
/settings
6
Enter
Down
Enter
Esc
Esc
```

Assert immediate durable appearance changes, Settings remains open after save, final return to same chat/draft, and plain mode restores raw/alternate-screen state before its next prompt.

Add one case per editor family and each external action family, plus stale config, active-run race, provider cancellation, unsupported Kimi action, and setup failure. No test may use the real default config path.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/settings-command.test.ts tests/cli.test.ts tests/integration.test.ts
```

Expected: FAIL because the CLI port/session factory is not wired.

- [ ] **Step 3: Implement owner-only dashboard/plain wiring**

Install `context.settings` only after execution mode has been derived. Do not add a second `/settings` pre-dispatch branch in `runDashboard`; let the shared `handleSlashCommand` call the port. Ensure temporary plain UI construction is dependency-injectable for tests.

- [ ] **Step 4: Run GREEN plus noninteractive regressions**

```bash
node --import tsx --test tests/settings-command.test.ts tests/cli.test.ts tests/integration.test.ts tests/commands.test.ts
npx tsc -p tsconfig.tests.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/setup-ui.ts tests/cli.test.ts tests/integration.test.ts tests/settings-command.test.ts
git commit -m "feat: wire guided settings into interactive cli"
```

---

### Task 9: Integrate Route Core into Start, Header, README, and Package

**Files:**

- Modify: `src/ui/dashboard-frame.ts`
- Modify: `src/ui/render-frame.ts`
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `scripts/check-package.mjs`
- Modify: `tests/branding.test.ts`
- Modify: `tests/ui-compose.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/commands-catalog.test.ts`
- Modify: `tests/cli-entrypoint.test.ts`

**Interfaces:**

Extend branding data explicitly:

```ts
export interface HeaderInfo {
  // existing fields
  brandMark?: string;
}

export interface DashboardBranding {
  readonly showLargeLogo: boolean;
  readonly showHeaderMark: boolean;
  readonly largeLines: readonly string[];
  readonly compactMark: string;
}
```

`headerSegments()` adds `brandMark` as a left segment below workspace/model/approval/SSH/context priority so it is the first decorative element dropped on narrow terminals. Approval and active SSH must remain visible at all widths where they were visible before.

When the chat block list is empty and no command/file/history list is open, `buildDashboardFrame()` shows the large Route Core + `ORCODE` + existing welcome line if `showLargeLogo`; otherwise it shows the existing welcome line alone. On constrained height it degrades to compact mark + wordmark, then welcome only. It never steals the minimum chat/input space.

`renderCliBanner()` and `printBanner()` use the same `branding.ts` line arrays for a local interactive start. Machine-readable help/version/JSON output remains stable unless its existing explicit banner test is updated; `/settings` never writes branding to stdout in JSON mode.

README begins with a relative reference to `assets/route-core.svg`, documents the same-terminal full-screen behavior, six categories, keys, immediate-save semantics, owner-only boundary, credential privacy, ASCII overrides, and `NO_COLOR`. Run the command-doc generator after prose edits.

Add `"assets"` to `package.json.files` and `assets/route-core.svg` to `STATIC_PACKAGE_FILES`/exact package assertions. Do not permit arbitrary asset files.

- [ ] **Step 1: Write failing placement, priority, docs, and package tests**

Prove:

- empty dashboard contains the exact large brand when on and not when off;
- non-empty chat header contains the compact mark when on and omits it when off;
- forced ASCII affects start/Settings/header together;
- level-0/`NO_COLOR` has the same plain geometry and no escape sequences;
- narrow header drops brand before workspace/model/approval/SSH;
- plain interactive banner uses the canonical renderer;
- README references exactly the canonical asset and contains the required Settings/security text;
- generated command block remains byte-exact;
- `npm pack --dry-run --json` contains exactly one SVG at the approved path.

- [ ] **Step 2: Run RED**

```bash
node --import tsx --test tests/branding.test.ts tests/ui-compose.test.ts tests/cli.test.ts tests/commands-catalog.test.ts tests/cli-entrypoint.test.ts
```

Expected: FAIL on missing placements/package metadata/docs.

- [ ] **Step 3: Implement all canonical brand consumers and docs**

```bash
node --import tsx scripts/render-command-docs.ts --write
```

Use one asset and one terminal branding module; a repository search must find no duplicate SVG path data or second terminal-art constant.

- [ ] **Step 4: Run GREEN and package check serially**

```bash
node --import tsx --test tests/branding.test.ts tests/ui-compose.test.ts tests/cli.test.ts tests/commands-catalog.test.ts tests/cli-entrypoint.test.ts
node --import tsx scripts/render-command-docs.ts --check
npm run build
npm run check:package
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard-frame.ts src/ui/render-frame.ts src/cli.ts README.md CHANGELOG.md package.json scripts/check-package.mjs tests/branding.test.ts tests/ui-compose.test.ts tests/cli.test.ts tests/commands-catalog.test.ts tests/cli-entrypoint.test.ts assets/route-core.svg
git commit -m "feat: apply route core branding"
```

---

### Task 10: Prove Real PTY Cleanup and Complete the Frozen-Tree Verification

**Files:**

- Modify: `tests/pty-release.test.ts`
- Modify: `tests/fixtures/pty-harness.mjs`
- Modify: `scripts/check-pty.mjs`
- Modify: `README.md` only if test evidence exposes an inaccurate statement
- Modify: `CHANGELOG.md` only if final verified scope differs from its entry

**Acceptance scenario:**

The real POSIX PTY harness starts orcode with a temporary app/config/workspace and synthetic providers, seeds a multiline draft plus an attachment fixture, opens `/settings`, navigates categories, enters and cancels a nested picker, changes one appearance choice, resizes, suspends/resumes, exits Settings, proves the same draft remains, then exits orcode. The transcript must contain enable/disable SGR mouse and alternate-screen sequences in balanced order, no secret sentinel, no raw provider identity, no duplicate keypress, and no hanging listener/process.

- [ ] **Step 1: Add the failing real-PTY scenario and release assertions**

Test at least:

```text
open -> nested picker -> Esc -> Settings -> resize -> suspend/resume -> Esc -> identical draft -> exit
```

Assert the saved config contains only the confirmed appearance change, file mode remains secure, and cancelled editor/provider actions made no provider/network/credential calls.

- [ ] **Step 2: Run the focused PTY RED test**

```bash
node --import tsx --test tests/pty-release.test.ts
```

Expected: FAIL until the harness and Settings scenario are complete.

- [ ] **Step 3: Implement the minimum harness support and fix only evidenced defects**

Do not weaken timing/assertions to hide listener, resize, raw-mode, or mouse cleanup defects. Keep POSIX claims bounded; do not claim native Windows proof.

- [ ] **Step 4: Self-review the implementation against the approved spec**

Run these structural scans and resolve every hit deliberately:

```bash
rg -n "TODO|TBD|placeholder|coming soon" src/settings-*.ts src/ui/settings-frame.ts src/branding.ts README.md CHANGELOG.md
rg -n "accountFingerprint|credentialSlot|apiKey|secret|requestId" src/settings-*.ts src/ui/settings-frame.ts
rg -n "handleSlashCommand\(.*\/|\/model|\/provider|\/allow" src/settings-*.ts
rg -n "M9 14h13l6 10" . --glob '!assets/route-core.svg' --glob '!docs/**'
git diff --check
```

Allowed scan hits must be test assertions, explicit safety comments, or truthful read-only provider maturity copy; production Settings view types may not carry forbidden identity/secret fields.

- [ ] **Step 5: Run focused feature suites**

```bash
node --import tsx --test tests/config.test.ts tests/settings-registry.test.ts tests/settings-controller.test.ts tests/settings-command.test.ts tests/settings-tui.test.ts tests/branding.test.ts tests/rules.test.ts tests/commands-catalog.test.ts tests/commands.test.ts tests/cli.test.ts tests/integration.test.ts tests/tui.test.ts
```

- [ ] **Step 6: Request independent read-only code review**

Review against the spec, with special attention to:

- owner/TTY rejection before effects;
- stale raw-byte CAS and durable-before-live publication;
- model/config/session/runtime all-old-or-all-new failpoints;
- provider confirmation/credential boundaries;
- safe view-model projection;
- chat draft/attachment/viewport/route preservation;
- editor and SGR/raw-mode settlement;
- single-source Route Core asset/terminal renderer;
- no placeholders or release claims.

Fix confirmed findings with focused RED tests before continuing.

- [ ] **Step 7: Freeze the tree and run all release gates serially**

Record the exact pass/fail/skip counts and current commit for each command:

```bash
npm run check
npm run build
npm run test:pty
npm run check:package
npm run check:release -- --tag v0.7.0
node --import tsx scripts/render-command-docs.ts --check
git diff --check
git status --short
```

`git status --short` must contain only intentionally untracked local collaboration/brainstorm artifacts already excluded from commits. A green POSIX PTY gate is not native Windows-DACL/ConPTY proof.

- [ ] **Step 8: Commit final PTY/docs corrections**

```bash
git add tests/pty-release.test.ts tests/fixtures/pty-harness.mjs scripts/check-pty.mjs README.md CHANGELOG.md
git commit -m "test: verify guided settings in real pty"
```

- [ ] **Step 9: Re-run frozen-tree gates on the final commit**

Repeat Step 7 after the final commit. Report the final commit hash, exact test counts, build/package/metadata status, PTY platform boundary, and any intentionally deferred non-goal. Do not tag, push, publish, or declare Stable.
