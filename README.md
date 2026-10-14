![Route Core logo](assets/route-core.svg)

# orcode

> **Development snapshot — not a 0.7 release.** This branch contains the newer
> CLI/desktop development source and the Route Core workbench UI. The installed
> app is not updated by viewing or cloning this branch. Browser/native acceptance,
> real owner login journeys, and release packaging remain separate gates.
> See [Development status](DEVELOPMENT.md). The design preview uses demo data only.

The current local GUI checkpoint adds native project selection, manual model
selection, independent AI-process/Permissions controls, and a real working-copy
flow with tests and confirmed Apply. That execution boundary is currently
**macOS-only**. Codex manufacturer login can be detected, but integrated native
Codex execution remains blocked pending its compatibility and isolation proofs.
Claude/Kimi manufacturer CLIs are not integrated GUI execution adapters.
Unsigned local builds do not have verified native installation/login authority.

**Native Windows GUI support is not ready yet.** The existing Windows CLI CI
does not prove the Rust GUI, process isolation or installer. The proposed port
targets Windows 11 x64 without WSL; see the
[Windows architecture draft](docs/superpowers/specs/2026-10-15-windows-native-design.md).
No Windows installer or completed Windows acceptance is claimed by this branch.

orcode is a local, terminal-based coding agent that runs against any
tool-capable model available on [OpenRouter](https://openrouter.ai/), rather
than being locked to a single model vendor. It keeps filesystem access and
shell execution on your machine, behind explicit, configurable approval
modes, and separates the cost of your main model from an optional, cheaper
compressor model that condenses long conversation context before it reaches
the main model. It is aimed at developers who want a scriptable, terminal-
first coding agent and want to choose (and pay for) exactly which model does
the work. A Kimi Code membership key can additionally be connected as a
**Preview** provider; see [Kimi Code (Preview)](#kimi-code-preview) for
exactly what that does and does not cover yet.

## Requirements

- **Node.js 22 or newer.** orcode is pure JavaScript/TypeScript on
  Node's standard library plus a small dependency set; it is not tied to a
  specific OS.
- **A key for at least one provider.** orcode's provider hub has three
  rows: OpenRouter Stable; Kimi Code Abo Preview (membership key);
  Anthropic / Claude-Abo Coming soon (not connectable yet). You need one of
  the first two:
  - **An OpenRouter API key** if you use OpenRouter. Get one at
    [openrouter.ai/keys](https://openrouter.ai/keys). orcode needs at
    least an inference key; an optional separate management key unlocks the
    `/balance` full-account view (see [Privacy and data flow](#privacy-and-data-flow)).
  - **A Kimi Code membership API key** if you use the Preview Kimi Code
    provider. This is a key you create yourself in the Kimi Code Console for
    third-party tools; it is not a Kimi login, and an ordinary chat on a
    Kimi route does not need an OpenRouter key alongside it. See
    [Kimi Code (Preview)](#kimi-code-preview) for what that connection does
    and does not cover yet.

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

2. On first run, with no key saved yet and no `OPENROUTER_API_KEY` in the
   environment, orcode shows the provider hub: OpenRouter Stable; Kimi Code
   Abo Preview; Anthropic / Claude-Abo Coming soon (cannot be selected yet).
   Choose one provider and paste that provider's key with hidden input:

   - **OpenRouter:** orcode validates the API key live against OpenRouter
     and then stores it in your OS's native credential store (Keychain on
     macOS, Credential Manager on Windows, Secret Service/libsecret on
     Linux). Later starts load and re-validate that saved key
     automatically. A valid but unfunded key stays saved and active: paid
     runs are blocked until credit is available, but the key is not erased
     and you are not asked to replace it. Expiry or exhausted limit metadata
     likewise does not erase a key; replacement is reserved for a missing
     key or an explicit authentication rejection, never a transient network
     error.
   - **Kimi Code Abo:** paste only your Kimi Code membership key; no
     OpenRouter key is requested for that route. The connection is
     validated against the Kimi catalog and stored in the same credential
     store. What this Preview provider does and does not cover is described
     in [Kimi Code (Preview)](#kimi-code-preview).

   If `OPENROUTER_API_KEY` is set, orcode activates OpenRouter from it
   instead of showing the hub (see below).

3. On an OpenRouter route, pick a model with `/model` (interactive search
   over OpenRouter's tool-capable models — shows pricing, context size, and
   capabilities), or pass one on the command line:

   ```bash
   orcode --model openrouter/auto
   ```

   A Kimi Code route uses one of the four Kimi model IDs listed in
   [Kimi Code (Preview)](#kimi-code-preview); `/provider models kimi-code`
   shows which of them your membership currently returns.

4. Choose an approval mode if the default (`ask`) is not what you want —
   see below — then just type your task at the prompt.

To skip the OpenRouter key prompt entirely (useful for scripting or CI), set
the key non-interactively. This applies to OpenRouter only; there is no Kimi
environment variable:

```bash
export OPENROUTER_API_KEY="your-key"
orcode
```

orcode deliberately has no `--key` command-line flag, since arguments
are visible in shell history and process listings. Use `/key set` inside
the app, or the environment variable, instead.

## Guided full-screen settings

### Nano-GPT: subscription and pay-as-you-go (preview)

Use `/provider connect nano-gpt`, or choose Nano-GPT in Desktop Settings →
Accounts. Choose **Abo** or **Guthaben** explicitly, enter the API key in the
local masked field, then select your model manually. The two modes are stored
as separate local connections; changing modes never happens automatically.

Subscription mode requires a subscription-only API key with paid-balance
spending disabled in Nano-GPT's key settings. Use a separate paid-capable key
for pay-as-you-go. The key is stored only in your native credential store,
not in configuration, chat history or logs. No environment-key discovery,
automatic model routing, paid fallback or hosted paid tools are enabled.

The integration uses Nano-GPT's native Responses API for text and function
tools. Available tool-capable models come from Nano-GPT's catalog. Numeric
balance, quota and costs are not fabricated when unavailable; unknown costs
cannot be enforced as a reliable local dollar cap. Separate summarizer,
panel, transcription and reasoning-override controls remain unavailable.
Fixture/SDK tests and public catalog verification are not proof of a live
authenticated request from your account.

See [Nano-GPT billing advice](https://docs.nano-gpt.com/api-reference/endpoint/subscription-usage)
and [Responses API](https://docs.nano-gpt.com/api-reference/endpoint/responses).

### Terminal settings

Run `/settings` from an owner-controlled interactive session to open the
guided Settings screen in the same terminal. It has five areas, organized
around what you're actually trying to do rather than internal plumbing:

1. Models
2. Accounts
3. Approvals & Costs
4. Tools
5. Appearance

`Models` leads with the rows people touch most: the main model and route,
then per-role thinking (main model, compressor, and — when Cross is
available — Cross's coding and review roles, each independently editable),
then one efficiency block (compression mode, compressor model, compressor
cost cap) grouped together instead of split across categories. The Cross
model pair itself is also set here — pick the coding (writes files) and
review (read-only) model independently, or swap them atomically — as the
*default* pair every Cross start shows pre-filled for one more conscious
confirmation; Settings never starts Cross and never auto-selects either
model.

The five categories are a tab bar under the title bar, and every row of the
active category is in one dense, scrollable list — `Name  value
explanation`, grouped by section headings where a category has natural
groups. Nothing is folded away behind a `More settings` step; rows that lie
outside the window are disclosed by the `N of M` counter and its `▾`/`▴`
marker. Search (`/` inside Settings) matches every row's label, description,
and aliases across **all five categories at once**, not just the one you're
currently viewing — so searching "efficiency" finds the compressor rows
regardless of which category is open. Existing German search terms (e.g.
"effizienz", "denken") keep working as aliases alongside their English
equivalents; every other piece of Settings and application text is English.
Use `1`–`5`, arrows, `Page Up`/`Page Down`, `Home`/`End`, `Enter`, `/`, and
`Esc`; the action bar names the keys that do something right now. Confirmed changes are saved immediately;
cancelling an editor — including a Cross model pick — leaves its value
unchanged. Below `40×8`, Settings accepts only `Esc` until the
terminal is large enough again.
Closing Settings restores the existing chat draft, attachments, history, route,
and viewport instead of starting a second application window.

Settings is an owner-only local surface. orcode never shares your subscriptions
with another user, pools accounts, or silently moves a running task to another
subscription. Credentials never enter the Settings view: secrets are collected
only inside the existing provider setup boundary and are not displayed there.
Provider and route changes are also rejected while a run is active.

The saved Appearance choices control the large logo, compact header mark, and
glyph mode. Set `ORCODE_ASCII=1` (or the legacy `ROUTERCODE_ASCII=1`) to force
ASCII glyphs for the whole terminal UI. `NO_COLOR` disables styling without
changing the selected logo geometry.

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

The menu presents the same actionable commands in the six task groups: Models,
Chat, Workspace, Accounts, Approvals & Costs, and System.

## Real Cross

Cross is an on-demand two-model run: the coding model is the only writer,
while the review model reviews the plan and result read-only.
Ordinary prompts remain single-model.
Every start path — bare `/cross`, `/cross run [task]`, and
`/cross models` (the retired `/collab cross …` spelling still resolves to
each of them) — opens the same single start gate
instead of separate flows: the pair (set ahead of time in Settings, or
picked here) shows pre-filled with honest role labels, each role is
independently confirmable or changeable, Start stays disabled until the pair
is complete and the two models differ, and the expected model-call range
with a cost estimate (or an honest "cost unknown" for provider-managed
pricing) is disclosed before anything runs. With no supplied task, the gate
consumes the preserved composer draft once; cancelling restores it
untouched and never reports success. `swap`, `status`, and `stop` exchange
the pair atomically, inspect the current or last run, or cancel and drain
both workers. Cross never starts from provider setup or from an ordinary
prompt, and it never auto-selects either model.

OpenRouter is the Stable, runnable provider in Slice 1.
Kimi Code Abo is a Preview provider connected with a membership key; see
[Kimi Code (Preview)](#kimi-code-preview) for its boundaries. Anthropic /
Claude subscription is shown truthfully as Coming soon and cannot be connected
yet; Claude models remain available through OpenRouter. Cross is optional and
on-demand, and provider setup, repair, disable, logout, and reconnect for every
provider keep Cross off until an explicit later `/cross` action.

<!-- orcode:command-docs:start -->
| Command | Aliases | Usage | Description |
| --- | --- | --- | --- |
| `/model` |  | `/model [provider/model\|current]` | Search, choose, or show the main model |
| `/fallback` | `/fallbacks` | `/fallback [+<model>\|-<model>\|clear]` | Maintain the fallback model chain behind the main model |
| `/think` | `/reasoning` | `/think [auto\|off\|level\|budget tokens]` | Control the reasoning level or thinking budget |
| `/compress` | `/compressor` | `/compress [mode\|model]` | Interactively choose the summarizer model or set when long chats get summarized |
| `/cross run` | `/collab cross run` | `/cross run [task]` | Start Cross with the given or received task |
| `/cross models` | `/collab cross models` | `/cross models` | Open Cross focused on choosing the coding and review models |
| `/cross swap` | `/collab cross swap` | `/cross swap` | Atomically swap the coding and review models |
| `/cross status` | `/collab cross status` | `/cross status` | Show the current or most recent Cross run |
| `/cross stop` | `/collab cross stop` | `/cross stop` | Cancel the active Cross run and stop both workers |
| `/cross off` | `/collab cross off` | `/cross off` | Turn off persistent Cross mode for this chat |
| `/panel` |  | `/panel <question> \| models <a>,<b>,… \| judge on\|off \| show <n> \| use <n>` | Ask multiple models in parallel and compare their answers |
| `/architect` |  | `/architect [task]` | Plan with the main model, then execute the accepted plan with the cheaper executor model |
| `/new` |  | `/new [title]` | Start a new, separate chat in this folder |
| `/fork` |  | `/fork [title]` | Fork the current chat, with its context, into a new chat |
| `/chat` | `/chats`, `/switch`, `/resume` | `/chat [new\|list\|open\|search\|rename\|fork\|delete]` | Search, choose, create, rename, or fork chats |
| `/history` |  | `/history [count]` | Show recent chat turns |
| `/context` | `/pin` | `/context [pin <n>\|unpin <n>]` | Show the context window's composition and fill, and pin turns as never-compress |
| `/compact` |  | `/compact` | Summarize this chat's context now, once, and report what it saved |
| `/goal` |  | `/goal [<text>\|off]` | Set, show, or clear a persistent goal injected into every run's context |
| `/checkpoint` | `/checkpoints` | `/checkpoint [list\|new [name]\|restore <id\|name>]` | Mark a point in the chat, or reset to a mark |
| `/image` | `/attach` | `/image [path\|clear]` | Choose an image, attach it by path, or clear attachments |
| `/whisper` | `/voice` | `/whisper` | Record voice input and insert it as text in the input line |
| `/export` |  | `/export [file]` | Print the chat as Markdown or write it to a file |
| `/clear` |  | `/clear` | Reset this chat's history and its recorded cost |
| `/diff` |  | `/diff` | Show the current git diff |
| `/undo` |  | `/undo [--dry-run]` | Revert the last run's file changes |
| `/recover` |  | `/recover [continue\|undo\|discard]` | Check, continue, undo, or discard an interrupted previous run |
| `/verify` |  | `/verify [on\|off\|now\|suggest\|clear\|rounds <n>\|<command>]` | Configure verification commands to run after changes |
| `/init` |  | `/init` | Create ORCODE.md in this folder |
| `/folder` |  | `/folder [open <path>\|new <path>]` | Change or create the workspace folder, re-rooting orcode into it |
| `/ssh` |  | `/ssh [<alias>\|status\|off]` | Choose, check, or disconnect an SSH target from ~/.ssh/config |
| `/web` |  | `/web [on\|off\|auto]` | Control the web search plugin for the main run |
| `/provider` |  | `/provider [setup\|connect\|login\|logout\|enable\|disable\|disconnect\|reconnect\|status\|models\|sort\|only\|ignore\|clear] \| data allow\|deny \| fallbacks on\|off` | Set up, connect, check, or disconnect provider accounts |
| `/key` |  | `/key [set\|replace\|save\|status\|forget\|management]` | Manage the OpenRouter key securely |
| `/balance` | `/credits` | `/balance` | Recheck balance and key limit |
| `/models` |  | `/models [search]` | List tool-capable models for the active provider |
| `/allow` | `/approval`, `/approvals`, `/permissions` | `/allow [mode\|list\|forget <id>\|forget all]` | Choose approvals; list or forget remembered rules |
| `/budget` |  | `/budget [day <USD>\|total <USD>\|on-exceed warn\|block]` | Show this folder's budget or set the daily/total limit |
| `/max-cost` |  | `/max-cost [USD]` | Set the cost limit per main-agent run |
| `/steps` |  | `/steps [count]` | Set the maximum number of actions per run |
| `/cost` | `/costs` | `/cost` | Show what this chat and this folder have cost |
| `/settings` | `/appearance`, `/theme` | `/settings [models\|accounts\|approvals\|tools\|appearance]` | Open guided settings in full screen, at a category if you name one |
| `/config` |  | `/config` | Show the stored, non-secret configuration |
| `/status` |  | `/status` | Show models, modes, limits, and folder |
| `/help` | `/?` | `/help` | Show all commands and their usage |
| `/quit` | `/exit`, `/q` | `/quit` | Quit orcode |
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
`-v`/`--version`. `--json` and unattended runs are not available on a Kimi
Code route; see [Kimi Code (Preview)](#kimi-code-preview).

## Kimi Code (Preview)

orcode can connect a Kimi Code membership as a second provider next to
OpenRouter. This provider is **Preview**: its behavior is verified with
recorded fixtures and repository tests only. Automated tests never use a live
Kimi credential, and the following live results have **not** been recorded
yet:

- an authenticated live model catalog (`GET /models` with a real membership
  key),
- streamed text from a live Kimi model,
- streamed reasoning from a live Kimi model,
- one complete live tool loop (model → tool call → tool result → model).

Until all four exist as sanitized evidence, the provider stays Preview, and
everything below describes the reviewed integration contract that the code
implements against fixtures — not a promise about your account.

### Setup with a membership key

orcode is a third-party tool for Kimi Code and uses only the documented
third-party integration path: a Kimi Code API key that you create yourself in
the Kimi Code Console and paste into orcode's hidden-input prompt
(`/provider connect kimi-code`). The only endpoint orcode talks to for Kimi
is `https://api.kimi.com/coding/v1`.

Setup validates the key with a single metadata call to the model catalog; it
never sends a chat completion just to test a key. The key is then stored in
your OS's native credential store, the same one OpenRouter keys use, and is
never written to `config.json`, chats, run logs, exports, or reports. Provider
state keeps only a local keyed fingerprint of the key that is never displayed.
Because Kimi's third-party API does not expose a fixed account ID, replacing
the key is conservatively treated as a possible account/billing change and
asks for explicit confirmation. `/key` continues to manage only the OpenRouter
key.

Exactly four model IDs are supported. orcode intersects the catalog your key
returns with this fixed list, ignores unknown IDs, and hides listed IDs that
your membership does not return:

| Model ID | Display name |
| --- | --- |
| `k3` | Kimi K3 |
| `k3-256k` | Kimi K3 256K |
| `kimi-for-coding` | Kimi K2.7 Code |
| `kimi-for-coding-highspeed` | Kimi K2.7 Code HighSpeed |

Which of these your membership tier can use, and how much, is decided by Kimi,
not by orcode. Limits are provider-managed, and Kimi may bill optional Extra
Usage on top of the membership. orcode therefore never presents a request as
costing nothing, never displays remaining quota, and shows Kimi costs as
`provider-managed / unknown` instead of a number; check usage in your Kimi
Code account. A model or tier your membership does not include is reported as
unavailable without discarding the key, and a catalog outage leaves the key
saved and the provider offline/unknown.

By contract, one Kimi connection with one model is enough for ordinary chat,
and OpenRouter is not required for it. That end-to-end path is exactly what
the live results listed above would record; it has not been recorded yet.

### Owner-only, local, interactive use

Kimi Code membership is for personal interactive use, and orcode enforces
that boundary: a Kimi route works only in a local, user-initiated interactive
orcode session under the OS account that holds the key. The following are
unavailable for Kimi and are rejected before any credential read or network
access:

- `--json` output and piped or otherwise unattended batch runs,
- scheduled or background execution,
- relay, remote, shared-service, shared-daemon, and multi-user setups,
- use by collaborators or through a shared subscription,
- resale and SaaS proxying.

Multi-user or automated Kimi use would need a separate design and separate
provider credentials; it cannot be enabled by configuration.

### What orcode deliberately does not do

- **No Kimi OAuth or device-code login.** That path belongs to the official
  Kimi CLI and VS Code extension; orcode does not copy their client identity,
  tokens, device codes, or User-Agent. Where the setup explanation shows
  `Sign in with Kimi · Coming soon`, that row is presentation only: it starts
  no process, opens no browser, and touches no file, credential, or network.
- **No Kimi CLI credential reuse.** orcode never reads the official client's
  credential store and never runs `kimi login`.
- **No browser cookies.**
- **No environment-variable fallback.** Unlike `OPENROUTER_API_KEY`, there is
  no Kimi environment variable; the saved membership key is the only source.
- **No Kimi Open Platform fallback.** A Moonshot / Kimi Open Platform
  pay-as-you-go key or base URL is never tried in place of the membership
  endpoint.

### Commands and lifecycle

All Kimi actions go through `/provider` and act on the exact selected Kimi
connection:

| Command | Effect |
| --- | --- |
| `/provider connect kimi-code` | Ask for a membership key with hidden input, validate it against the catalog, store it, and bind the route. |
| `/provider enable kimi-code` | Re-enable a disabled connection, reading only the exact retained key. |
| `/provider disable kimi-code` | Keep the key, but make the next startup perform zero Kimi credential reads and zero network calls. |
| `/provider reconnect kimi-code` | Re-run the catalog inspection on the saved key and rebind the route. |
| `/provider status` | Show safe state only: readiness, `Preview`, billing realm, health, and `Cross: off`/`on` — never the key, a fragment, an account ID, an email address, or a quota figure. |
| `/provider models kimi-code` | List the supported models your membership currently returns. |
| `/provider logout kimi-code` | After an explicit confirmation, clear every route bound to that connection and delete the stored key. |

`/provider disconnect` is not offered for Kimi. Cross stays **off** after every
one of these actions and after setup, model change, repair, recovery, and
restart; only an explicit later `/cross` action can start it.

### Unsupported features on Kimi routes

Image attachments (`/image`), voice input (`/whisper`), `/panel`, and `/web`
have no Kimi runtime contract yet. On a Kimi route they are unavailable, and
orcode does not fall back to OpenRouter for them. The compressor uses the
exact same Kimi connection and model or is disabled; a Kimi-only session never
reads an OpenRouter key. `/models` still lists OpenRouter models — use
`/provider models kimi-code` for Kimi.

## Privacy and data flow

- **What leaves your machine on an OpenRouter route:** your prompts, the
  contents of files the agent reads or writes, shell command output, and Git
  diffs are sent to OpenRouter and, through it, to whichever underlying
  model provider is behind the model you selected (for example Anthropic,
  OpenAI, Google, or another OpenRouter-listed provider, depending on your
  choice). If you use the compressor, the same applies to whatever session
  context it processes — potentially a different provider than your main
  model, since the compressor model is chosen independently. If you enable
  `/web`, search queries go through OpenRouter's web-search plugin as well.
  On an OpenRouter route, nothing is sent anywhere else by orcode itself.
- **With a Kimi Code route,** the same categories of data go to
  `api.kimi.com` (Kimi) instead of OpenRouter, for the main model and — if
  enabled — for the compressor, which uses the same Kimi connection. Every
  request carries orcode's own product/version identity. Kimi error
  responses are reduced to fixed orcode messages; response bodies, headers,
  and request IDs are neither shown nor logged.
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
  variables removed. The same applies to a saved Kimi Code membership key.
  If the same value is deliberately included in file or conversation
  content, the exact recovery-artifact exception above still applies.
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
`npm run test:release-regressions`, `npm run test:pty`, and
`npm run test:journeys` are local release gates. Run the metadata gate with
the exact intended tag, for example `npm run check:release -- --tag v0.7.0`.
The package check performs both
`npm pack --dry-run --json` and a real
tarball install, scans publishable text for recognizable credentials and
private checkout paths, and runs both CLI aliases. The PTY gate is a real POSIX
PTY test on macOS/Linux; it is explicitly not ConPTY coverage on Windows.
`npm run test:journeys` is that same real-PTY family's owner-journey suite:
it drives the real built `dist/cli.js`/`dist/tui.js` through seven pinned,
named journeys (hub launch with an existing chat, `/new`, opening a Recent
chat, quitting a fresh hub, the per-prompt cost forecast, and — in colour and
under a real `NO_COLOR=1` — the screen anatomy across the palette, Settings
and a Settings editor) end to end,
the way an owner actually uses the CLI, rather than one component at a time.
Like `npm run test:pty`, it requires a fresh `npm run build` first and is
not part of `npm run check` (a real PTY session is slower and more
environment-sensitive than the rest of the suite).

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
TAG=v0.7.0
gh workflow run release.yml --repo dkay95/orcode --ref "$TAG" -f tag="$TAG"
```

The owner Required Reviewer then approves the environment review from a
different account than the initiator. The workflow refuses to publish unless
the protected dispatch tag, workflow-definition ref, immutable dispatch-event
commit, metadata, and artifact all agree.

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
