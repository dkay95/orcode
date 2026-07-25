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

Optional, not required:

- **[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on your `PATH`.**
  The `search_files` tool uses it when present for faster search. Without
  it, orcode falls back to a built-in searcher with the same output
  format — search still works, just slower on very large workspaces.
- **A POSIX-compatible shell for `run_command` on Windows.** Shell commands
  run through `/bin/sh -c` by default on every platform. macOS and Linux
  ship `/bin/sh`; a native Windows install does not. Until this is fixed
  upstream, set the `ROUTERCODE_SHELL` environment variable to a shell
  orcode can actually invoke — for example the `bash.exe` that ships
  with [Git for Windows](https://git-scm.com/download/win) — if you need
  the shell-command tool on Windows. `/model`, `/chat`, file edits, search,
  and everything else that isn't `run_command` (or `git_diff`, `/diff`,
  `/verify`) works without it.

## Install

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
   re-validate that saved key automatically; you are asked again only if it
   is missing, expired, exhausted, or rejected outright — not on a
   transient network error.

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

`run_command` runs through a non-login shell (`/bin/sh -c` by default, see
[Requirements](#requirements) for the Windows caveat) specifically so it does
not source your shell's login/profile files, which would undo the
credential-scrubbing described below. `git_diff` is treated like a shell
command for approval purposes — it still launches a process and can read
repository-controlled configuration — and is blocked in `read-only` mode;
the `/diff` slash command, by contrast, is a direct user action and does not
ask.

## The compressor pipeline

orcode uses two distinct model roles. The compressor receives the
existing session context plus your current request and produces a dense
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

| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/model` | | `/model [provider/model\|current]` | Search, select, or show the main model |
| `/think` | `/reasoning` | `/think [auto\|off\|level\|budget tokens]` | Control reasoning effort or thinking-token budget |
| `/allow` | `/approval`, `/approvals`, `/permissions` | `/allow [mode\|list\|forget <id>\|forget all]` | Choose the approval mode; list or forget remembered rules |
| `/chat` | `/chats`, `/switch` | `/chat [new\|list\|open\|search\|rename\|fork]` | Browse, select, create, rename, or fork chats |
| `/new` | | `/new [title]` | Start a new, separate chat in this workspace |
| `/fork` | | `/fork [title]` | Fork the current chat, including context, into a new chat |
| `/compress` | `/compressor` | `/compress [mode\|model]` | Interactively choose the compressor model or configure its mode |
| `/image` | `/attach` | `/image [path\|clear]` | Pick an image (macOS only, see below), attach one by path, or clear pending attachments |
| `/whisper` | `/voice` | `/whisper` | Record from the microphone and insert the transcript into the input line |
| `/status` | | `/status` | Show models, modes, limits, and workspace |
| `/key` | | `/key [set\|status\|forget\|management]` | Manage the OpenRouter API key securely |
| `/balance` | `/credits` | `/balance` | Re-check account balance and key limit |
| `/reconnect` | | `/reconnect` | Rebuild and verify the OpenRouter connection |
| `/models` | | `/models [search]` | List tool-capable OpenRouter models |
| `/cost` | `/costs` | `/cost` | Show costs for this workspace session |
| `/max-cost` | | `/max-cost [USD]` | Set a cost limit per main-agent run |
| `/steps` | | `/steps [count]` | Set the maximum tool steps per run |
| `/budget` | | `/budget [day <USD>\|total <USD>\|on-exceed warn\|block]` | Show workspace budget or set a daily/total limit |
| `/verify` | | `/verify [on\|off\|now\|suggest\|clear\|rounds <n>\|<command>]` | Configure verification commands to run after changes |
| `/web` | | `/web [on\|off\|auto]` | Control the web-search plugin for the main run |
| `/provider` | | `/provider [sort <mode>\|allow\|deny\|only …\|ignore …\|clear]` | Set OpenRouter provider routing policy |
| `/fallback` | `/fallbacks` | `/fallback [+<model>\|-<model>\|clear]` | Maintain a fallback model chain behind the main model |
| `/history` | | `/history [count]` | Show recent conversation turns |
| `/checkpoint` | `/checkpoints` | `/checkpoint [list\|new [name]\|restore <id\|name>]` | Mark a point in the chat, or restore to a mark |
| `/export` | | `/export [file]` | Print the chat as Markdown, or write it to a file |
| `/diff` | | `/diff` | Show the current Git diff |
| `/undo` | | `/undo [--dry-run]` | Undo the last orcode run as a unit |
| `/clear` | | `/clear` | Reset conversation context and session costs |
| `/init` | | `/init` | Create a `ROUTERCODE.md` template in the workspace |
| `/config` | | `/config` | Show saved, non-secret configuration |
| `/help` | `/?` | `/help` | Show all commands and their usage |
| `/quit` | `/exit`, `/q` | `/quit` | Exit orcode |

`/compress model` also has its own sub-menu: `model`, `auto`, `always`,
`off`, `threshold <characters>`, and `max-cost <USD>`.

`/image` with no argument opens a native file picker, but that picker is
implemented with `osascript` and only works on macOS; on other platforms use
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
  user-only file permissions where the OS supports that. Obvious secrets
  are redacted before anything is written.
- **The API key never touches disk in plaintext.** It is stored only in
  your OS's native credential store via `@napi-rs/keyring` — never in
  `~/.orcode/`, an ordinary file, a session, or a log — and it is never
  passed to a child process as a command-line argument. Shell commands run
  by the `run_command` tool receive a sanitized copy of your environment
  with variables whose names look like keys, tokens, secrets, passwords,
  credentials, authorization data, or cookies removed.
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
│       └── <chat-id>.json    # one file per persistent chat
├── runs/
│   └── <chat-id>/
│       └── <run-id>.ndjson   # append-only per-run event log
└── sessions/                  # legacy pre-multi-chat session files, left untouched
```

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

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
