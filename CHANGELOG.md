# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once a 1.0.0 release is tagged. Before 1.0.0, minor versions may include
breaking changes.

## [Unreleased]

This release redesigns the owner-terminal experience end to end, following a
Dieter Rams design audit (13/30 — REDESIGN verdict) that found the shipped
command discovery, Settings information architecture, account setup, and
Cross start flow useful/understandable/honest failures, while confirming the
terminal-first visual language was worth preserving. Every surface below was
rebuilt or renovated against that audit; none of it is a restyle of the old
tree under new names.

### Added

- **Terminal look:** the accent and active colors move to a warmer amber
  (`#e8890c`/ANSI 172, `#ffb020`/ANSI 214) and several glyphs change for
  clarity and terminal-width safety — the tool-line head (`▸`→`●`), the block
  result foot (`└`→`⎿`), the bold user-turn gutter (`▌`→`>`), the completion
  marker (`›`→`❯`), the assistant gutter (now an accent-colored `● `), and the
  busy spinner (braille frames → `✻✽✶✳✢·`). A new `↪` glyph (ASCII fallback
  `~`) marks mid-run interjections. Every ASCII fallback, ASCII/Unicode
  environment detection, ANSI/light-dark theme architecture, and the Route
  Core brand marks are unchanged.
- A conversation-first Route Core workbench with the large mark reserved for
  the empty invitation, the compact mark in the working header, and
  one command surface shared by `/` and Ctrl+P: typing any prefix searches
  every executable command globally from the first keystroke, an empty query
  still browses the root groups, and a query with no matches offers to open
  the full list instead of a dead end.
- One searchable, provider-aware route picker shared by `/model`, Settings,
  and Cross instead of separate model selectors with different behavior.
- A guided full-screen `/settings` surface, restricted to the local owner,
  rebuilt around five plain user jobs instead of the old four-category tree
  and its 16-row "Mehr" catch-all: **Models**, **Accounts**,
  **Approvals & Costs**, **Tools**, and **Appearance**. Search (`/` inside
  Settings) now matches every row's label, description, and aliases across
  every category at once — not just the currently open one — and still finds
  a row by its German alias (e.g. "effizienz") alongside the new English
  ones. `Models` groups the route, thinking, and efficiency rows together in
  one prominent block near the top: main-model route, then per-role
  thinking, then compression mode and compressor model (moved out of the old
  model/safety split into one place); the summarizer cost cap, the
  low-balance warning, and actions-per-run sit together in
  `Approvals & Costs`, which is where every limit on what a run may spend or
  do now lives. Every existing
  row keeps its persistence semantics, owner-only gating, and immediate
  durable saves with unchanged-chat restoration on cancel.
- Reasoning ("thinking") is now visible and independently editable per model
  role, not only for the main model: **Thinking · main model**,
  **Thinking · compressor**, **Thinking · Cross coding**, and
  **Thinking · Cross review** each show and edit that role's own effort
  level, disabled with a concrete reason when the role's model is unset or
  doesn't support reasoning. `/think` still writes only the main model's
  setting, and now names the model it changed so the per-role story stays
  honest.
- The Cross model pair (coding model — writes files; review model —
  read-only) is now configurable ahead of time in Settings, as three rows
  in `Models`: pick each role's model independently, or swap them atomically.
  Settings defines the *default* pair; it is never auto-selected and every
  Cross start still shows it pre-filled for one conscious confirmation or
  change before anything runs.
- On-demand `/cross` coordination (the older `/collab cross …` spelling
  still resolves, as a compatibility alias): every start path — bare,
  `run [task]`, and `/cross models` — opens one explicit start
  gate showing the coding (writes files) and review (read-only) models
  pre-filled with honest role labels (never bare "Lead"/"Challenger"), each
  consciously confirmable or changeable, Start disabled until the pair is
  valid, and the expected model-call range with a cost estimate (or an
  honest "cost unknown") disclosed before commitment; verification and
  review phases, at most one disclosed repair, and no silent fallback to an
  ordinary single-model run.
- Mid-run interjections and finite thinking: a line typed while a run is
  active feeds the running task instead of queuing for the next one,
  rendered as `> ↪ <text>` with an acceptance footer; the input line stays
  open the whole run with an explicit "Type an interjection …" hint, and
  interjections are never a way to change the approval mode or skip a gate.
  Interjections persist as ordinary session turns and replay correctly after
  `--continue` or a crash. Live reasoning shows an elapsed-time header
  (`ctrl+o` toggles the detail); `esc` while reasoning streams live ends only
  the thinking and lets the run continue with what it has, while `esc`
  outside of live reasoning keeps its existing run-abort meaning — the two
  are distinguished by run state, never by timing.
- An active `/ssh` target now shows as a muted `ssh:<host>` segment in the
  status line for as long as it's remembered, and on every remote tool line
  (`● SSH <host>(<command>)`); `/ssh off` removes the segment immediately.
  The `/ssh` host list adopts the standard numbered look.
- A capability-truthful account setup surface, rebuilt from scratch: only
  runnable authentication actions are ever selectable — Codex, Anthropic, and
  Kimi OAuth render as plain, non-selectable explanations until their backend
  actually exists — every provider discloses its login type and cost
  boundary before any secret prompt, and cancelling a step never reports
  success. Cross-role model preparation no longer happens inside onboarding;
  choose the Cross pair in Settings or the Cross start gate instead.
- Every provider, model, and Cross surface now follows one documented
  async-state contract (empty/loading/error/success/focus/disabled/cancel/
  recovery), and the browser, voice, and provider-specific modules load only
  once their feature is actually used instead of at every startup —
  measurably lowering the CLI's initial JavaScript footprint.
- All owner-facing UI text — help, errors, prompts, notices, and Settings
  copy — is now in English. Settings search keeps recognizing the previous
  German terms as aliases alongside the new English ones, so existing muscle
  memory (e.g. "effizienz", "denken") still finds the same rows.

### Fixed

- Direct slash commands retain every typed argument, root Backspace edits the
  composer, complete commands execute on the first Enter, and real terminal
  Return/Escape/Backspace bytes navigate Ctrl+P instead of becoming search
  text.
- Account setup no longer reports success after a cancelled step.

### Security

- Settings is owner-only, never exposes credential slots or account
  fingerprints, and never shares or pools subscriptions between users or
  accounts.
- Cross keeps Challenger sessions read-only and isolated; only the selected
  Lead may publish workspace changes; Cross stays unavailable on Kimi Code
  routes, enforced from every entry point (Settings, the start gate, and the
  command layer alike).

## [0.7.0] - 2026-08-25

### Added

- Kimi Code membership provider (**Preview**). `/provider connect kimi-code`
  takes a user-created Kimi Code membership API key with hidden input,
  validates it with one catalog call against `https://api.kimi.com/coding/v1`,
  stores it in the OS credential store, and keeps only a never-displayed keyed
  account fingerprint in provider state. Exactly four model IDs are supported
  and gated by the returned catalog: `k3`, `k3-256k`, `kimi-for-coding`, and
  `kimi-for-coding-highspeed`. `enable`, `disable`, `reconnect`, `status`,
  `models`, and `logout` complete the lifecycle; `status` shows safe state only.
- Kimi limits are provider-managed and paid Extra Usage may apply; orcode shows
  Kimi costs as provider-managed/unknown, displays no quota, and never presents
  a request as costing nothing.

### Security

- Kimi Code is restricted to owner-only local interactive use. JSON, piped or
  unattended batch, scheduled, relay, collaborator, shared-service, multi-user,
  resale, and SaaS use are rejected before any credential read or network
  access.
- No Kimi OAuth/device-code login, Kimi CLI credential reuse, browser cookies,
  environment-variable key fallback, or Kimi Open Platform fallback exists;
  `Mit Kimi anmelden` remains Coming soon and has no effect. Kimi error
  responses are reduced to fixed messages without bodies, headers, request IDs,
  or key fragments.

### Known limitations

- Image, voice, `/panel`, and `/web` are unavailable on Kimi routes and do not
  fall back to OpenRouter; the compressor uses the same Kimi connection or is
  disabled. Cross stays off through every Kimi setup, command, and recovery
  path.
- Kimi remains Preview and fixture-verified: the authenticated live catalog,
  streamed text, streamed reasoning, and one-tool-loop smokes are not yet
  recorded.

## [0.4.1] - 2026-08-23

### Added

- The npm package manifest and non-destructive per-user installer expose both
  `orcode` and the backwards-compatible `routercode` command. Registry
  publication remains a separate owner action.
- Live process output, bounded automatic verification and repair, hardened Git,
  browser and SSH execution, and explicit reconnectable credential state.

### Changed

- Command help, completion, dispatch, and README documentation now share one
  generated catalog and package-derived version metadata.
- Chat-owned local data now follows one private, migratable, retention-aware
  storage boundary, including redacted human-readable logs and exact recovery
  artifacts with separate limits.
- Release preparation now uses a four-entry OS/Node CI matrix, an exact
  dry-run/real tarball gate, a historical migration fixture, and a real POSIX
  PTY smoke. Publishing is manual through npm Trusted Publishing / OIDC after
  the package owner completes the first-publication bootstrap and externally
  configures the `npm-production` GitHub environment with a Required Reviewer,
  self-review prevention plus a distinct trusted initiator, protected `v*`
  deployment refs, and separate owner-only creation plus no-bypass
  update/delete rulesets for `v*` tags; no long-lived npm token is stored in the
  workflow.

### Security

- Approval rules use exact structured subjects, model routing validates every
  main-role candidate, and automatic Git reads bind repository metadata and
  configuration immediately before process launch.

## [0.4.0] - 2026-07-27

### Added

- Packaging for public npm distribution: `LICENSE` (Apache-2.0), `NOTICE`,
  `CONTRIBUTING.md`, this changelog, a trimmed `files` list in `package.json`,
  and a `prepublishOnly` script that runs the full check suite and a fresh
  build before anything can be published.
- CI workflow that runs the build, both TypeScript checks, and the test
  suite on a Linux/macOS/Windows x Node 22 matrix, plus a tag-triggered
  release workflow that publishes to npm.
- Startup warning on stderr when the workspace root is the user's entire
  home directory, pointing to `-C` for scoping orcode to a project folder.
- `/chat delete <ID|Titel>` (alias `rm`): permanently removes a chat via
  the new `SessionStore.remove`; ambiguous titles always abort instead of
  guessing, and deleting the active chat switches to a fresh one so
  auto-save does not resurrect the file.
- PowerShell support for `run_command`/`runVerify` on Windows: without a
  configured `ORCODE_SHELL`, `powershell.exe -NoProfile -NonInteractive
  -Command` is the default there instead of the nonexistent `/bin/sh`;
  `pwsh`/`powershell` overrides get the correct flags on every platform.
- Outbound secret scanner (warn-only): the model-bound context is scanned
  before every API call and every tool result is scanned before it enters
  the conversation history; common credential patterns (OpenRouter/OpenAI/
  Anthropic keys, AWS, GitHub, GitLab, Slack, Google, npm tokens, private
  key blocks) trigger a visible German warning. Nothing is redacted or
  blocked — the agent legitimately works on files containing tokens.

### Changed

- README rewritten in English for an external audience, with the private
  local install path removed and the command list generated from
  `src/command-catalog.ts` instead of hand-copied.

### Security

- Path-policy directory rules now match case-insensitively. On
  case-insensitive filesystems (macOS APFS, Windows NTFS) a spelling like
  `.GIT/hooks/pre-commit` resolves to the real `.git/hooks/` on disk but
  previously bypassed the only hard `deny` rule, and `.SSH/` bypassed the
  secret-read approval.
- Secret-file protection extended: `.npmrc`, `.netrc`/`_netrc`,
  `.git-credentials`, and `*.key`/`*.p12`/`*.pfx`/`*.keystore`/`*.jks` now
  require approval on read and write (like `.env`); `.gnupg/**`,
  `.kube/**`, and `.docker/**` now require approval on read (like `.aws`).

## [0.3.0] - 2026-07-25

This is the first version documented in this changelog. It reflects the
state of the CLI going into public release, not a diff against a prior
tagged version — no earlier version was tagged or changelogged.

### Added

- **Approval-aware sandbox.** File reads/writes are confined to the
  workspace with symlink-escape protection. A path policy layered on top of
  the chosen approval mode always requires an explicit yes for `.git/**`,
  `.env*`, `node_modules/**`, `.ssh/**`, and `.github/workflows/**`, and
  permanently blocks writes under `.git/hooks/**`. Reading files that look
  like secrets (`.env*`, `*.pem`, `id_rsa`, `.ssh/**`, `.aws/**`) requires
  approval too, since their content would otherwise be sent to the model
  verbatim. Four approval modes (`read-only`, `ask`, `auto-edit`,
  `allow-all`) govern file edits and shell commands independently;
  `allow-all` still blocks a fixed set of catastrophic shell patterns
  (`rm -rf /`, disk erasure, raw writes to `/dev`, shutdown/reboot, etc.) as
  a speed bump, not a security boundary.
- **Persistent permission rules.** Approvals can be remembered per
  command/path so the same prompt is not repeated every run; remembered
  rules can never override a hard `alwaysAsk` policy path, and they can be
  listed or forgotten via `/allow list` / `/allow forget`.
- **Compressor pipeline.** A separate, cheaper model can produce a dense
  handoff of the existing session context before the main model sees the
  current request. Modes are `off`, `auto` (triggered by a configurable
  character threshold), and `always`; the original current request is
  always sent to the main model unmodified alongside the handoff.
- **Conversation memory with prompt caching.** Session/model state is
  structured so repeated requests hit the provider's prompt cache instead of
  re-sending an ever-growing prefix, cutting cost and latency on long-running
  chats.
- **Verification gate.** After a run that touched files, user-configured
  verification commands (tests, linters, build) run automatically outside
  the tool-approval path, so a green result means a real process exited
  cleanly rather than "the agent didn't throw." Configurable via `/verify`.
- **Run log.** Each run is written as an append-only NDJSON event log under
  `~/.orcode/runs/<chat-id>/`, independent of the chat transcript, for
  post-hoc debugging and auditing.
- **Fullscreen terminal dashboard** with a redesigned render layer: a fixed
  status/footer area, a scrollable chat viewport, chronological tool cards
  with duration and result summaries, live run clock and token/cost
  counters, in-dashboard model/approval pickers, and cancellable runs with
  signal-safe terminal restoration. A `--plain` mode remains for terminals
  without full-screen support.
- **Multiple persistent chats per workspace**, each with independent
  context, model, reasoning setting, title, timestamps, and cost ledger;
  `/chat`, `/new`, and `/fork` manage them. Two orcode instances writing
  the same chat merge instead of clobbering each other; an unreadable chat
  or config file is moved aside instead of overwritten.
- **Cost and budget controls**: per-run step and cost limits, and an
  optional daily/total workspace budget with `warn` or `block` behavior.
- **OpenRouter account integration**: hidden API-key entry backed by the
  native OS keychain, an optional separate management key for account-credit
  checks, tool-capable model discovery via `/models`, and bounded automatic
  reconnection with backoff for transient network/provider failures.
- Slash-command catalog (`src/command-catalog.ts`) shared by `/help` and the
  in-dashboard command palette, so behavior and documentation cannot drift
  apart.
- Undo for orcode's own file edits, `/checkpoint` markers within a chat,
  `/export` to Markdown, `/diff` for the current Git diff, image attachments,
  and project instructions loaded from `AGENTS.md` / `ROUTERCODE.md`.
