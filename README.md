# orcode

orcode is a local, terminal-based coding agent that runs against any
tool-capable model available on [OpenRouter](https://openrouter.ai/), rather
than being locked to a single model vendor. It keeps filesystem access and
shell execution on your machine, behind explicit, configurable approval
modes, and separates the cost of your main model from an optional, cheaper
compressor model that condenses long conversation context before it reaches
the main model. It is aimed at developers who want a scriptable, terminal-
first coding agent and want to choose (and pay for) exactly which model does
the work.

## Requirements

- **Node.js 22 or newer.** orcode is pure JavaScript/TypeScript on
  Node's standard library plus a small dependency set; it is not tied to a
  specific OS.
- **An OpenRouter API key.** Get one at
  [openrouter.ai/keys](https://openrouter.ai/keys). orcode needs at
  least an inference key; an optional separate management key unlocks the
  `/balance` full-account view (see [Privacy and data flow](#privacy-and-data-flow)).

Shell execution is platform-native; Windows does not require an additional
POSIX shell:

- macOS and Linux use `/bin/sh -c` by default.
- Windows uses `powershell.exe -NoProfile -NonInteractive -Command` by
  default.

Set `ORCODE_SHELL` to override that platform default. If `ORCODE_SHELL` is
unset, the legacy `ROUTERCODE_SHELL` variable is used as a compatibility
fallback. The override must name a shell orcode can actually invoke.

## Install

The registry commands below become available only after the package owner's
first registry publication. If `npm` still reports that `orcode` does not
exist, run the checked-out source instead:

```bash
npm ci
npm run build
node dist/cli.js
```

After that first publication, run without installing globally:

```bash
npx orcode
```

or install it globally:

```bash
npm install -g orcode
orcode
```

## Quick start

1. Start orcode in a project directory:

   ```bash
   cd your-project
   orcode
   ```

2. On first run, with no `OPENROUTER_API_KEY` in the environment and no key
   saved yet, orcode asks for your OpenRouter API key with hidden
   input, validates it live against OpenRouter, and then stores it in your
   OS's native credential store (Keychain on macOS, Credential Manager on
   Windows, Secret Service/libsecret on Linux). Later starts load and
   re-validate that saved key automatically. A valid but unfunded key stays
   saved and active: paid runs are blocked until credit is available, but the
   key is not erased and you are not asked to replace it. Expiry or exhausted
   limit metadata likewise does not erase a key; replacement is reserved for a
   missing key or an explicit authentication rejection, never a transient
   network error.

3. Pick a model with `/model` (interactive search over OpenRouter's
   tool-capable models — shows pricing, context size, and capabilities), or
   pass one on the command line:

   ```bash
   orcode --model openrouter/auto
   ```

4. Choose an approval mode if the default (`ask`) is not what you want —
   see below — then just type your task at the prompt.

To skip the API-key prompt entirely (useful for scripting or CI), set the
key non-interactively:

```bash
export OPENROUTER_API_KEY="your-key"
orcode
```

orcode deliberately has no `--key` command-line flag, since arguments
are visible in shell history and process listings. Use `/key set` inside
the app, or the environment variable, instead.

## Approval modes

This is the safety-relevant part of orcode; it is described here
precisely rather than promotionally.

| Mode | File edits | Shell commands |
| --- | --- | --- |
| `read-only` | blocked | blocked |
| `ask` | ask every time | ask every time |
| `auto-edit` | automatic | ask every time |
| `allow-all` | automatic | automatic |

Set the mode at startup with `--approval <mode>` (or `-a`), or change it
during a session with `/allow`.

Regardless of mode, a path policy always requires an explicit yes for
`.git/**`, `.env*`, `node_modules/**`, `.ssh/**`, and
`.github/workflows/**`, and `.git/hooks/**` is never writable through
orcode at all. Reading a file that looks like a secret (`.env*`,
`*.pem`, `id_rsa`, `.ssh/**`, `.aws/**`) also requires approval, because its
content would otherwise be sent to the model verbatim. Approvals for a
specific command or path can be remembered so you are not asked again; list
or remove remembered rules with `/allow list` and `/allow forget`.

`allow-all` shows an explicit warning on startup and still keeps built-in
file tools confined to the workspace, and it still permanently blocks a
small, fixed set of catastrophic shell patterns (`rm -rf /`, disk erasure,
filesystem creation, raw writes to `/dev`, shutdown, reboot, and similar).
That check is a speed bump against an obvious total loss, **not a security
boundary**: it is not an OS-level sandbox, and any shell command it does
allow can reach anything the current user account can reach — including,
in `allow-all`, without asking first.

`run_command` uses the selected platform shell without loading a user profile:
macOS and Linux use `/bin/sh -c`; Windows uses
`powershell.exe -NoProfile -NonInteractive -Command`. `ORCODE_SHELL` overrides
the default, with `ROUTERCODE_SHELL` retained only as its compatibility
fallback. Avoiding profile startup prevents it from undoing the
credential-scrubbing described below. `git_diff` is treated like a shell
command for approval purposes — it still launches a process and can read
repository-controlled configuration — and is blocked in `read-only` mode;
the `/diff` slash command, by contrast, is a direct user action and does not
ask.

## The compressor pipeline

orcode uses two distinct model roles. The compressor receives only the prior
session context — it never receives the current prompt or current attachments —
and produces a dense
handoff that tries to preserve constraints, paths, commands, errors,
decisions, tests, and unfinished work; the main model then receives both
that handoff and your original request, sent separately and unmodified, so
compression can never silently replace the instruction you actually gave.

Modes, set with `/compress`:

- `off` — never call the compressor
- `auto` (default) — call it once the configured context-character
  threshold is reached
- `always` — run the compressor before every main-model request

```text
Default main model:       openrouter/auto
Default compressor model: qwen/qwen3.5-flash-02-23
Default mode:              auto
Default threshold:         18000 characters
```

`/models` queries OpenRouter live for the current catalog rather than
relying on a hard-coded list, since model availability and pricing change.

## Commands

Slash commands, generated from the same catalog orcode's `/help` and
in-app command palette use (`src/command-catalog.ts`), so this list cannot
drift from what the app actually offers:

OpenRouter is the Stable, runnable provider in Slice 1. Anthropic / Claude
subscription is shown truthfully as Coming soon and cannot be connected yet;
Claude models remain available through OpenRouter. Cross is optional and
on-demand, and provider setup, repair, disable, logout, and reconnect all keep
Cross off until an explicit later `/collab` or `/cross` action.

<!-- orcode:command-docs:start -->
| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/model` |  | `/model [anbieter/modell\|current]` | Main-Modell suchen, auswählen oder anzeigen |
| `/think` | `/reasoning` | `/think [auto\|off\|Stufe\|budget Tokens]` | Reasoning-Stufe oder Thinking-Budget steuern |
| `/allow` | `/approval`, `/approvals`, `/permissions` | `/allow [Modus\|list\|forget <id>\|forget all]` | Freigaben wählen; gemerkte Regeln (K6) auflisten oder vergessen |
| `/chat` | `/chats`, `/switch` | `/chat [new\|list\|open\|search\|rename\|fork\|delete]` | Chats durchsuchen, auswählen, anlegen, umbenennen oder verzweigen |
| `/new` |  | `/new [Titel]` | Einen neuen, getrennten Chat im Workspace beginnen |
| `/fork` |  | `/fork [Titel]` | Aktuellen Chat samt Kontext als neuen Chat verzweigen |
| `/compress` | `/compressor` | `/compress [Modus\|model]` | Kompressor-Modell interaktiv wählen oder Modus konfigurieren |
| `/image` | `/attach` | `/image [Pfad\|clear]` | Bild auswählen, per Pfad anhängen oder Anhänge leeren |
| `/whisper` | `/voice` | `/whisper` | Spracheingabe aufnehmen und als Text in die Eingabezeile einfügen |
| `/status` |  | `/status` | Modelle, Modi, Limits und Workspace anzeigen |
| `/key` |  | `/key [set\|status\|forget\|management]` | OpenRouter-Schlüssel sicher verwalten |
| `/balance` | `/credits` | `/balance` | Guthaben und Key-Limit erneut prüfen |
| `/reconnect` |  | `/reconnect` | OpenRouter-Verbindung neu aufbauen und prüfen |
| `/models` |  | `/models [Suche]` | Tool-fähige OpenRouter-Modelle auflisten |
| `/panel` |  | `/panel <frage> \| models <a>,<b>,… \| judge on\|off \| show <n> \| use <n>` | Mehrere Modelle parallel befragen und Antworten vergleichen |
| `/cost` | `/costs` | `/cost` | Kosten dieser Workspace-Sitzung anzeigen |
| `/max-cost` |  | `/max-cost [USD]` | Kostenlimit pro Main-Agent-Lauf setzen |
| `/steps` |  | `/steps [Anzahl]` | Maximale Tool-Schritte pro Lauf setzen |
| `/budget` |  | `/budget [day <USD>\|total <USD>\|on-exceed warn\|block]` | Workspace-Budget anzeigen oder Tages-/Gesamtlimit setzen |
| `/verify` |  | `/verify [on\|off\|now\|suggest\|clear\|rounds <n>\|<befehl>]` | Verifikationskommandos nach Änderungen konfigurieren (A4) |
| `/web` |  | `/web [on\|off\|auto]` | Websuche-Plugin für den Hauptlauf steuern (A2) |
| `/provider` |  | `/provider [setup\|connect\|enable\|disable\|disconnect\|reconnect\|status\|models\|logout\|sort\|allow\|deny\|only\|ignore\|fallback\|clear]` | OpenRouter Stable verwalten; Anthropic / Claude-Abo Coming soon |
| `/fallback` | `/fallbacks` | `/fallback [+<modell>\|-<modell>\|clear]` | Fallback-Modellkette hinter dem Main-Modell pflegen (A3) |
| `/history` |  | `/history [Anzahl]` | Letzte Gesprächsrunden anzeigen |
| `/checkpoint` | `/checkpoints` | `/checkpoint [list\|new [Name]\|restore <ID\|Name>]` | Stand im Chat markieren oder auf eine Marke zurücksetzen |
| `/export` |  | `/export [Datei]` | Chat als Markdown ausgeben oder in eine Datei schreiben |
| `/diff` |  | `/diff` | Aktuellen Git-Diff anzeigen |
| `/undo` |  | `/undo [--dry-run]` | Letzten orcode-Lauf als Einheit zurücknehmen |
| `/resume` |  | `/resume [fortsetzen\|undo\|verwerfen]` | Abgebrochenen vorherigen Lauf prüfen, fortsetzen, zurücknehmen oder verwerfen |
| `/clear` |  | `/clear` | Gesprächskontext und Sitzungskosten zurücksetzen |
| `/init` |  | `/init` | ORCODE.md im Workspace anlegen |
| `/ssh` |  | `/ssh [<alias>\|status\|off]` | SSH-Ziel aus ~/.ssh/config wählen, prüfen oder trennen |
| `/config` |  | `/config` | Gespeicherte, nicht geheime Konfiguration anzeigen |
| `/help` | `/?` | `/help` | Alle Befehle und ihre Verwendung anzeigen |
| `/quit` | `/exit`, `/q` | `/quit` | orcode beenden |
<!-- orcode:command-docs:end -->

`/compress model` also has its own sub-menu: `model`, `auto`, `always`,
`off`, `threshold <characters>`, and `max-cost <USD>`.

`/image` with no argument opens a native file picker implemented with
`osascript`; that picker is macOS-only. On Windows and Linux, use
`/image <path>` directly.

`/whisper` records up to 120 seconds or 25 MB, whichever comes first; Enter
stops and transcribes, Esc cancels. It uses Swift/AVFoundation on macOS, and
falls back to `ffmpeg`, `arecord`, or `parecord` if present — whichever is
found first. The first recording asks for one-time consent to send audio to
OpenRouter for transcription (`transcriptionModel` in the config); the
transcript lands in the input line, never sent automatically.

`/clear` deliberately does not reset the daily budget counter — otherwise
the limit would be one command away from being useless. `/export` writes
through the same path policy as the write tools, so it cannot be used to
reach a protected path.

Command-line flags: `-C`/`--cwd <path>` (workspace), `-p`/`--prompt <text>`
(run one task non-interactively and exit), `-m`/`--model <id>`,
`-a`/`--approval <mode>`, `--compress <mode>`, `--new`, `--continue`,
`--chat <id>`, `--plain` (non-fullscreen output, for terminals without
full-screen support or for debugging), `--json`, `-h`/`--help`,
`-v`/`--version`.

## Privacy and data flow

- **What leaves your machine:** your prompts, the contents of files the
  agent reads or writes, shell command output, and Git diffs are sent to
  OpenRouter and, through it, to whichever underlying model provider is
  behind the model you selected (for example Anthropic, OpenAI, Google, or
  another OpenRouter-listed provider, depending on your choice). If you use
  the compressor, the same applies to whatever session context it
  processes — potentially a different provider than your main model, since
  the compressor model is chosen independently. If you enable `/web`,
  search queries go through OpenRouter's web-search plugin as well. Nothing
  is sent anywhere else by orcode itself.
- **What stays local:** orcode's own state — chat transcripts,
  compressed handoffs, timestamps, costs, checkpoints, tool-call records,
  and the append-only run log — lives under `~/.orcode/` on your
  machine (see [Local state](#local-state) below) and is written with
  user-only file permissions where the OS supports that. Human-readable
  chat JSON, run-event logs, and Markdown exports are written from a clone
  with recognizable credential patterns replaced. This is pattern-based
  protection, not a guarantee that arbitrary sensitive prose is removed.
- **Exact recovery artifacts are not redacted:** ChangeJournal checkpoints
  retain exact before/after file content so `/undo` can restore bytes, and
  the SDK conversation-state sidecars contain opaque serialized recovery
  state that orcode does not inspect. Treat `~/.orcode/` as sensitive local
  data even though its human-readable chats, run events, and exports pass
  through the redaction boundary.
- **The configured API key is not written to app state by the credential
  subsystem.** It is stored in your OS's native credential store via
  `@napi-rs/keyring`, is not passed to a child process as a command-line
  argument, and shell tools receive an environment with credential-like
  variables removed. If the same value is deliberately included in file or
  conversation content, the exact recovery-artifact exception above still
  applies.
- **The optional management key** is used only for the account-wide
  `GET /credits` call behind `/balance`; it is never sent to a model or to
  a child process. Without it, orcode still validates your inference
  key and reports its own usage and remaining limit, and says plainly that
  the full account balance isn't available.

## Local state

```text
~/.orcode/
├── config.json               # non-secret settings: model, approval mode, budgets, ...
├── chats/
│   └── <workspace-id>/
│       ├── <chat-id>.json          # one redacted persistent chat
│       └── <chat-id>.json.state.json # opaque SDK recovery state
├── runs/
│   └── <chat-id>/
│       └── <run-id>.ndjson         # redacted versioned event envelopes
├── checkpoints/
│   └── <chat-id>/
│       └── <run-id>.json           # exact ChangeJournal restore data
├── migrations/               # validated migration manifests
└── migration-backups/        # bounded exact backups of imported legacy state
```

Legacy pre-multi-chat session data is imported and mapped to the current chat
layout during the awaited startup migration. Exact source bytes are retained
only in the bounded migration backup, rather than being treated as live state.

Two orcode instances editing the same chat merge their state on write
instead of overwriting each other's turns. If a chat or config file on disk
can't be parsed at all, orcode moves it aside (`<file>.konflikt-<time>`
for chats, `config.json.beschaedigt` for a broken config) instead of
overwriting it, reports the problem, and continues with defaults.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for build, test, and contribution
conventions. In short:

```bash
npm install
npm run check   # typecheck (source + tests) and run the test suite
npm run build   # compile to dist/
```

The test suite never calls a paid model.

### Release boundary

`npm run check:package`, `npm run test:migration`,
`npm run test:release-regressions`, and `npm run test:pty` are local release
gates. Run the metadata gate with the exact intended tag, for example
`npm run check:release -- --tag v0.4.1`. The package check performs both
`npm pack --dry-run --json` and a real
tarball install, scans publishable text for recognizable credentials and
private checkout paths, and runs both CLI aliases. The PTY gate is a real POSIX
PTY test on macOS/Linux; it is explicitly not ConPTY coverage on Windows.

These gates are intended for a source checkout; they are not an installed-package
API. The first registry publication is an explicit package-owner bootstrap
action: npm requires the package to exist before its Trusted Publisher can be
configured. After that bootstrap, configure npm
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) for repository
`dkay95/orcode`, workflow `release.yml`, and GitHub environment
`npm-production`. Before the workflow is authorized for use, the repository
owner must configure that environment in GitHub with an owner as Required
Reviewer, enable prevent self-review, and arrange for a distinct trusted
maintainer or restricted release bot to dispatch the workflow. A sole-owner
setup cannot both initiate and approve the same protected deployment, so it is
not release-authorized until that second identity exists. Restrict environment
deployment refs to protected `v*` tags. Configure two separate repository tag
rulesets for `v*`: a creation restriction whose only bypass actor is the owner,
and a second update/delete restriction with no bypass actors. This lets the
owner create a release tag without granting anyone a route to move or delete it.
Naming the environment or either ruleset in documentation does not prove those
external settings exist.

After those settings have been verified, later releases use the manual workflow,
OIDC, and npm provenance without a long-lived npm token. Pushing a tag alone
never publishes. A trusted initiator dispatches the workflow explicitly from the
existing release tag and repeats the same tag as input:

```bash
TAG=v0.4.1
gh workflow run release.yml --repo dkay95/orcode --ref "$TAG" -f tag="$TAG"
```

The owner Required Reviewer then approves the environment review from a
different account than the initiator. The workflow refuses to publish unless
the protected dispatch tag, workflow-definition ref, immutable dispatch-event
commit, metadata, and artifact all agree.

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
