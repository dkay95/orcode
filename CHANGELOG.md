# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once a 1.0.0 release is tagged. Before 1.0.0, minor versions may include
breaking changes.

## [Unreleased]

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
