# Orcode Guided Settings and Route Core Branding Design

**Date:** 2026-08-25

**Target branch:** `codex/orcode-0.7-design`

**Status:** Chat design approved; written specification awaiting final user review

## 1. Goal

Add `/settings` as an owner-operated, full-screen settings experience inside
the existing terminal application. It temporarily replaces the chat view,
guides the user through every supported user-facing setting, saves each
confirmed change immediately, and returns to the unchanged chat with `Esc`.

Introduce the selected **Route Core** identity as orcode's canonical logo. The
large mark appears on the start screen and in Settings, while a compact mark
appears in the normal chat header. A terminal-safe ASCII fallback is mandatory.

The feature must reuse existing validation, provider authority, credential,
route-binding, confirmation, and persistence boundaries. A visually complete
settings screen must not become a second implementation of those rules.

## 2. User outcome

From an idle local interactive orcode session, the user enters:

```text
/settings
```

The chat is replaced by one full-screen Settings view:

- categories on the left;
- settings and current values on the right;
- `Up`/`Down` to move;
- category number keys `1` through `6` for direct navigation;
- `Enter` to open a guided chooser, validated value prompt, or confirmation;
- `/` to search settings by label, description, alias, or current value;
- `Esc` to close a nested editor, return from search, move back one level, and
  finally return to the same chat;
- SGR mouse selection where the existing TUI already supports it.

Opening, searching, navigating, or cancelling Settings has zero persistent,
provider, credential, route, or network effects. A change is applied only after
the user explicitly confirms a final selection or valid value.

After a successful change, Settings remains open, refreshes from authoritative
state, and restores focus to the changed row. Changes already confirmed remain
saved when the user exits with `Esc`.

## 3. Execution boundary

`/settings` is available only in a local interactive owner terminal. It may
temporarily enter the full-screen Settings mode even when the surrounding chat
uses the plain interactive presentation.

The command must fail before mutation, credential access, or provider/network
access in JSON, piped, unattended batch, scheduled, relay, collaborator,
shared-service, or other non-owner execution modes. The failure is a fixed,
secretless `settings-interactive-required` result with guidance to use an
interactive terminal. It must not silently fall back to editing the config file
or printing an interactive prompt into machine-readable output.

Settings may open while the chat is idle. While an agent run owns runtime or
route state, route-, provider-, model-, approval-, tool-, and budget-affecting
rows remain visible but disabled with the fixed explanation `Lauf aktiv`.
Read-only status rows remain available. Settings never cancels an active run to
make an edit possible.

## 4. Information architecture

The first release contains six categories and only real, functional settings.
No row may be a placeholder or Coming-soon control.

### 4.1 Models and reasoning

- Main model and exact provider-backed session route.
- Reasoning mode or supported effort for the selected model.
- Compressor mode and compressor model.
- Maximum tool steps per run.

Main-model selection must use the existing provider-aware model catalogue and
atomic route/runtime/session binding. It may not write `mainModel` independently
of the route identity. Unsupported reasoning controls remain unavailable with a
fixed local explanation rather than being degraded silently.

### 4.2 Providers and accounts

- Current route and safe provider status.
- Open the existing provider setup hub.
- Connect, enable, disable, reconnect, refresh/list models, and logout for each
  connectable provider.
- OpenRouter provider sort, data-collection policy, allow/ignore lists, and
  provider fallback policy.

Account rows show safe display names, maturity, lifecycle state, health, and
billing realm only. They never show a raw key, key fragment, raw account ID,
raw provider response, request ID, header, cookie, or private storage path.

The existing Kimi local-interactive-owner restriction remains unchanged.
Settings does not add OAuth, device-code login, Kimi CLI credential reuse,
Open Platform fallback, account pooling, shared subscriptions, or collaborator
access.

### 4.3 Security and approvals

- Approval mode: read-only, ask, auto-edit, or allow-all.
- List remembered approval rules.
- Forget one remembered rule or all rules, with existing confirmation rules.
- OpenRouter data-collection preference and provider allow/ignore controls.

The menu must explain the effect of each approval mode before confirmation.
Destructive or permission-expanding actions require the same confirmation and
authority checks as their slash-command equivalents.

### 4.4 Costs and budgets

- Main-run USD ceiling.
- Compressor USD ceiling.
- Daily workspace budget or off.
- Total workspace budget or off.
- On-exceed action: warn or block.
- Read-only current workspace/session cost summary, including explicit
  provider-managed/unknown Kimi cost knowledge.

Settings must not fabricate a numeric zero, remaining quota, or enforceable USD
limit for provider-managed unknown costs.

### 4.5 Verify and tools

- Verify mode, configured commands, suggestion flow, clear action, and repair
  rounds.
- Web mode: on, off, or auto.
- Browser executable path and bounded timeout.
- Panel model set and judge toggle.
- Voice transcription model selected only from compatible audio-input models.

Granting microphone/provider consent remains an explicit just-in-time action in
the voice flow. Settings may show consent state and clear prior consent, but it
must not mark consent as granted merely because a settings row was selected.

### 4.6 Appearance

- Route Core large-logo visibility: on or off, default on.
- Compact chat-header mark: on or off, default on.
- Glyph mode: auto, Unicode, or ASCII, default auto.

`ORCODE_ASCII=1` and the backwards-compatible `ROUTERCODE_ASCII=1` remain hard
runtime overrides and force ASCII regardless of the persisted preference.
`NO_COLOR` continues to disable color without hiding or deforming the mark.
Appearance settings change presentation only and never affect stored chat or
provider identity.

## 5. Route Core identity

The approved Route Core mark is an open hexagonal routing core connected to two
right-side endpoints: one filled upper endpoint and one outlined lower endpoint.
It communicates a local agent routing work between models and tools without
copying a provider's identity.

The repository owns one canonical transparent SVG with no external font,
script, image, or network dependency. It is used in the README and remains
legible on light and dark backgrounds. The terminal renderer owns hand-tuned
large and compact Unicode forms plus a structurally equivalent ASCII form; it
does not attempt to rasterize the SVG in the terminal.

Brand placement is fixed:

- large mark and `ORCODE` wordmark on the interactive start screen;
- large mark and wordmark in the Settings title area;
- compact mark in the normal chat header;
- canonical SVG above the README introduction.

The logo is static. This scope adds no animation, splash delay, sound, theme
engine, custom color picker, or provider-specific rebranding.

## 6. Architecture

### 6.1 Command entry

`src/command-catalog.ts` becomes the single source for `/settings`, help,
completion, aliases, and generated README command documentation. The command
handler requests an interactive Settings session through a typed `CommandContext`
port. It does not edit config directly and does not recursively feed synthetic
slash-command strings back into `handleSlashCommand`.

### 6.2 Settings registry

A new pure settings registry owns stable category IDs, item IDs, labels,
descriptions, search aliases, editor kinds, read-only/disabled state, and action
IDs. It contains no credentials, filesystem access, provider clients, ANSI, or
terminal input handling.

Every visible item must derive its displayed value and availability from an
authoritative read-only snapshot. Dynamic provider rows are produced from the
safe provider status projection rather than from credential storage.

The registry is the single source for both the dedicated full-screen UI and any
plain interactive adapter used by tests or future surfaces.

### 6.3 Settings controller

A controller coordinates one Settings session and exposes typed operations:

- open/close;
- select category/item;
- enter/leave search;
- request an editor;
- confirm/cancel;
- refresh authoritative state;
- apply one typed settings action.

Simple config actions build a complete candidate config, validate it, persist
it atomically against the exact previously read snapshot, and publish it to the
running context only after durable success. A failed or stale write leaves the
old in-memory and on-disk value unchanged.

Complex actions use explicit existing typed ports:

- provider lifecycle runtime and setup surface;
- provider-aware main-model selection and exact session route binding;
- approval rule store;
- model catalogue and capability filters;
- verify command validation;
- panel and voice model selection.

The controller never receives a raw provider secret. Hidden credential input
continues to terminate inside the existing provider setup boundary.

### 6.4 Full-screen TUI mode

The TUI gains a dedicated `settings` mode rather than representing Settings as
a chain of unrelated choice pickers. Its render input is a pure Settings view
model. Keyboard and SGR mouse events produce controller intents; rendering does
not mutate application state.

Opening Settings preserves the complete chat view model, draft input,
attachments, scroll position, selected chat, session route, and runtime owner.
Closing Settings restores those values exactly. Resizing, suspending, resuming,
or cancelling a nested picker must balance raw-mode listeners and mouse
reporting exactly once.

Nested editors may reuse the existing model picker, generic choice picker,
hidden secret prompt, validated text/number input, and confirmation primitives.
After settlement they return to the dedicated Settings screen at the previous
row.

### 6.5 Branding renderer

A small pure branding module owns Route Core terminal lines and the compact
header mark for Unicode and ASCII modes. Startscreen, Settings, and chat header
consume that module; none embeds a separate copy. The canonical SVG is an asset,
not generated at runtime.

## 7. Persistence and concurrency

Confirmed simple changes follow this order:

1. Read the current authoritative config snapshot.
2. Reject if the action was based on a different snapshot.
3. Build and validate a complete candidate.
4. Acquire the existing bounded config write lock.
5. Recheck the exact on-disk snapshot.
6. Atomically write the candidate.
7. Publish the new config to the live context.
8. Refresh Settings and restore focus.

No UI success message is emitted before step 7. A write or publication failure
returns a fixed local error and shows the authoritative old value. Provider and
route actions retain their stricter existing transactional/recovery protocols;
the generic config sequence does not replace them.

If another process changes config while an editor is open, Settings reports
`Einstellung wurde parallel geändert`, reloads current state, and requires a new
selection. It never performs last-writer-wins from a stale Settings snapshot.

## 8. Error handling

- Invalid numeric/text input stays in the editor with a bounded explanation and
  no write.
- `Esc`, EOF, terminal stop, or owner abort settles every pending editor once,
  clears hidden input, disables mouse reporting, and restores the prior screen.
- Unavailable catalog/provider state leaves the current value selected and
  exposes only the existing safe failure code/message.
- A settings-registry programming error fails closed and exits Settings without
  rewriting config.
- Future or corrupt config/provider state remains read-only and cannot be
  normalized or overwritten by Settings.
- A logo/glyph rendering limitation falls back to ASCII; it never prevents the
  CLI from starting or returning to chat.

## 9. Documentation

README changes must document:

- `/settings` and its local-interactive boundary;
- navigation and immediate-save semantics;
- the six categories;
- that provider credentials are never displayed;
- Route Core branding and ASCII/`NO_COLOR` behavior.

The generated command table remains owned by `src/command-catalog.ts`; the
renderer is not hand-edited. The changelog records the Settings UI and Route
Core branding without claiming a native macOS window, web settings page, new
provider support, or a release/publication.

## 10. Test and acceptance gates

### 10.1 Pure registry/controller tests

- Stable unique category/item/action IDs and deterministic ordering.
- Every row has a real action or read-only projection; no placeholder rows.
- Search covers labels, descriptions, aliases, and safe displayed values.
- Current-value projection and active-run disabled state.
- Immediate-save success, validation failure, write failure, stale-snapshot
  conflict, refresh, and focus restoration.

### 10.2 Command and execution tests

- `/settings`, help, aliases, completion, and generated docs share the catalogue.
- JSON, piped, batch, relay, collaborator, and non-owner paths produce zero
  mutation, credential, provider, and network effects.
- Provider actions preserve current confirmation, authority, lease, recovery,
  logout, and exact route-binding contracts.
- Main-model changes remain atomic across model, route, session, and runtime.

### 10.3 TUI and branding tests

- Category/item navigation, number shortcuts, search, mouse selection, nested
  editors, confirmations, `Esc` hierarchy, and return to unchanged chat.
- Draft input, attachments, scroll, chat identity, and session route survive a
  Settings round trip.
- Resize, narrow terminals, suspend/resume, terminal stop, raw-mode listener,
  and SGR mouse lifecycle.
- Large and compact Route Core output in Unicode, forced ASCII, and `NO_COLOR`.
- Startscreen, Settings, header, and README use the one approved identity.

### 10.4 Frozen-tree gates

Run serially on the completed branch:

```bash
npm run check
npm run build
npm run test:pty
npm run check:package
npm run check:release -- --tag v0.7.0
git diff --check
git status --short
```

The PTY result proves POSIX behavior only. Native Windows support requires its
own CI/host evidence. Tests use synthetic providers and credentials; no paid or
live Kimi/OpenRouter request is authorized by this design.

## 11. Explicit non-goals

- No second macOS Terminal window, native settings window, browser settings
  page, or local HTTP settings server.
- No automatic multi-account subscription pooling or credential sharing.
- No new provider authentication mechanism.
- No raw config editor or secret viewer.
- No background/scheduled settings mutation.
- No theming system beyond logo visibility, compact-mark visibility, and glyph
  mode.
- No tag, push, npm publish, or Stable promotion as part of implementation.

## 12. Completion criteria

The feature is complete only when `/settings` provides the approved full-screen
flow, every visible row is functional or explicitly read-only, immediate saves
are atomic and concurrency-safe, provider/credential boundaries remain intact,
the Route Core identity appears in every approved location with ASCII fallback,
all acceptance gates pass, and the branch contains no unfinished Settings or
Route Core placeholder.
