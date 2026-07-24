# RouterCode

RouterCode is a local coding-agent CLI powered by OpenRouter. It keeps filesystem
and shell execution on the local machine, supports multiple approval modes, and
can compress long context with a cheaper model before handing the task to the
main model.

## What works

- Hidden OpenRouter API-key input or `OPENROUTER_API_KEY`
- Encrypted API-key persistence in the native system keychain
- Optional, separately isolated management key for full account credits
- Key validation before use
- Account-credit check when the key is a management key
- Inference-key usage and remaining-limit check for regular keys
- Tool-capable OpenRouter model discovery
- Separate main and compressor models
- `off`, `auto`, and `always` context compression
- `read-only`, `ask`, `auto-edit`, and `allow-all` approval modes
- Workspace-confined file reads and writes with symlink-escape protection
- File search, exact replacements, full file writes, shell commands, and git diff
- Per-run step and cost limits
- Multiple persistent chats per workspace with separate context, model,
  reasoning setting, title, timestamps, and cost ledger
- `/` commands, undo for RouterCode file edits, and project instructions
- Fullscreen terminal dashboard with fixed status and input areas
- Scrollable chat viewport with streamed model output and inline approvals
- AI-generated quick replies after each answer, selectable with arrow keys while
  the normal free-form input remains available
- Live run clock, last-event age, model step, token/reasoning usage, and active
  tool duration in the fixed footer
- Chronological tool cards with start, completion/error, duration, compact
  result summary, and correctly segmented assistant text
- In-dashboard model search, masked key replacement, and destructive confirmations
- Cancellable model runs and signal-safe terminal restoration
- Bounded automatic reconnects for connection failures, timeouts, rate limits,
  and temporary OpenRouter/provider errors

OpenRouter documents the current endpoints used here:

- [Current API key metadata](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key)
- [Remaining credits](https://openrouter.ai/docs/api/api-reference/credits/get-credits)
- [Agent SDK](https://openrouter.ai/docs/agent-sdk/overview)
- [Tool approval and state](https://openrouter.ai/docs/agent-sdk/call-model/tool-approval-state)

## Install

Requires Node.js 22 or newer.

```bash
cd /Users/dogancankaya/projekt/routercode
npm install
npm run check
npm run install:user
```

`install:user` builds the CLI and creates a non-destructive symlink under
`~/.local/bin/routercode`. It refuses to overwrite an unrelated existing file
or link.

## API key

The recommended non-interactive setup is:

```bash
export OPENROUTER_API_KEY="your-key"
# Optional, only for the management-only /credits endpoint:
export OPENROUTER_MANAGEMENT_KEY="your-management-key"
routercode
```

If no key has been saved yet and the variable is missing, RouterCode asks with
hidden input. After successful live validation, it stores the key in the native
system keychain (`macOS-Schlüsselbund` on macOS). Later starts load and validate
that credential automatically. The prompt returns only when the saved key is
missing, expired, exhausted, or rejected by OpenRouter; a temporary network or
provider error does not delete it.

Use `/key status` to inspect the storage state, `/key set` to validate and
replace the saved credential, and `/key forget` to remove it from both process
memory and the system keychain. The optional management key follows the same
rules through `/key management set|status|forget`.

RouterCode deliberately has no `--key` option because command-line arguments can
appear in shell history and process lists.

The key itself is never written to `~/.routercode`, ordinary files, project
files, sessions, or logs. The native keychain binding does not pass the secret
as a child-process argument. Shell tools receive a sanitized environment with
variables whose names look like keys, tokens, secrets, passwords, credentials,
authorization data, or cookies removed.

The inference key is used for model requests. The optional management key is
used only for `GET /credits`; it is never passed to the model client or child
processes. Without a management key, RouterCode still validates the inference
key and checks its usage and remaining spending limit, while clearly reporting
that the full account balance is unavailable.

## Start

Use the current directory:

```bash
routercode
```

Use another project:

```bash
routercode -C /path/to/project
```

Run one task:

```bash
routercode -C /path/to/project -p "Run the tests and diagnose the failure"
```

The normal interactive start opens a chat chooser with `New Chat` selected, so
starting RouterCode does not silently append to the previous conversation.
Choose an existing chat to continue it, or use one of the explicit modes:

```bash
routercode --new -C /path/to/project
routercode --continue -C /path/to/project
routercode --chat <id> -C /path/to/project
```

The RouterCode dashboard keeps
the workspace, Git branch/change count, selected and resolved model, model
context/pricing/capabilities, OpenRouter balance, session costs, approval mode,
compressor, run limits, and key state visible. Only the chat viewport in the
middle scrolls; the input, current activity, and key hints stay fixed at the
bottom. The dashboard appears before network-backed key, balance, Git, and model
metadata checks complete, so slow startup work is visible and cancellable.

During a run, the fixed footer distinguishes preparation, model waiting,
reasoning, text streaming, active tools, reconnects, and completion. It updates
once per second and shows total run time, the age of the last real event,
current step, queued inputs, active tool duration, cumulative tokens, reported
reasoning tokens, tool count, and run cost. Tool cards remain in chronological
order between the assistant text that preceded and followed them.

After a completed model answer, RouterCode can display two to four short
`ANTWORTVORSCHLÄGE`. Use the up/down arrows or Tab to select one and Enter to
send it. Typing immediately writes an independent reply instead; `Esc` hides the
suggestions. They are generated in the same model call, stripped from the
visible transcript and never trigger an additional suggestion-model request.

Use `PageUp` and `PageDown` to move through chat text, the up/down arrows to
recall prior inputs, and `Esc` to clear the current input. Tool approvals appear
in the fixed footer and accept `y` or reject with `n`/Enter. During a model run,
`Ctrl+C` requests cancellation; pressing it again forces RouterCode to exit
after restoring the terminal.

`/model`, `/allow`, `/chat`, `/key set`, `/key management set`, `/clear`, `allow-all`
confirmation, and tool approvals stay inside the fullscreen dashboard. Secret
input is rendered only as bullets and is validated before it replaces the
credential in the system keychain.

For terminals that do not support the fullscreen interface, or for debugging,
use the classic output:

```bash
routercode --plain -C /path/to/project
```

Temporary startup overrides:

```bash
routercode \
  --model openrouter/auto \
  --approval ask \
  --compress auto
```

## Approval modes

| Mode | File edits | Shell commands |
| --- | --- | --- |
| `read-only` | blocked | blocked |
| `ask` | ask every time | ask every time |
| `auto-edit` | automatic | ask every time |
| `allow-all` | automatic | automatic |

`allow-all` is intentionally explicit and displays a warning on startup. It
still keeps built-in file tools inside the workspace and permanently blocks a
small set of catastrophic shell patterns such as `rm -rf /`, disk erasure,
filesystem creation, raw writes to `/dev`, shutdown, and reboot. It is not an OS
sandbox: an arbitrary allowed shell command can still reach anything available
to the current user.

## Compressor pipeline

RouterCode has two distinct model roles:

1. The compressor receives existing session context plus the current request.
2. It creates a dense handoff that preserves constraints, paths, commands,
   errors, decisions, tests, and unfinished work.
3. The main model receives both that handoff and the original current request.

The original current request is always sent separately so compression cannot
silently replace the authoritative instruction.

Modes:

- `off`: never call the compressor
- `auto`: call it once the configured context-character threshold is reached
- `always`: run the cheap model before every main-model request

Defaults:

```text
Main:       openrouter/auto
Compressor: qwen/qwen3.5-flash-02-23
Mode:       auto
Threshold:  18000 characters
```

All values can be changed with slash commands. Because model availability and
pricing change, `/models` queries OpenRouter instead of keeping a hard-coded
catalog.

## Slash commands

```text
/status
/key set
/key status
/key forget
/key management set
/key management status
/key management forget
/balance
/reconnect
/models [search]
/model
/model current
/model <provider/model>
/allow [read-only|ask|auto-edit|allow-all]
/approval
/chat
/chat list
/chat new [title]
/chat open <id|title>
/chat rename <title>
/chat fork [title]
/new [title]
/fork [title]
/compress [off|auto|always]
/compress model                    # interaktive Modellauswahl
/compress model <provider/model>   # Modell direkt setzen
/compress threshold <characters>
/compress max-cost <USD>
/cost
/max-cost [USD]
/steps [count]
/history [count]
/diff
/undo
/clear
/init
/config
/help
/quit
```

Model, compressor, key, balance, and model-list requests retry temporary
connection failures automatically with bounded backoff. The fixed activity line
shows when a reconnect is prepared, which attempt is running, and when the
connection has been restored. `/reconnect` performs an immediate fresh
connection, key, and balance check. Authentication and other permanent client
errors are not retried and never cause a saved key to be deleted unless
OpenRouter actually rejects that credential.

`/init` creates a `ROUTERCODE.md` template in the active workspace. RouterCode
loads root-level `AGENTS.md` and `ROUTERCODE.md` as project instructions.

`/model` opens an interactive search inside the fixed dashboard. Start typing
any part of a model name or ID, use the arrow or PageUp/PageDown keys to move,
and press Enter to select. The picker shows pricing, context size,
tool/reasoning/image capabilities, and the OpenRouter description.
`/model current` prints the full details again.

`/allow` and `/approval` open an interactive approval picker. Typing either
command and pressing Tab preserves the chosen alias; the arrow keys select a
mode and the lower details panel explains its effect. `allow-all` still requires
an explicit confirmation.

`/chat` opens the workspace chat picker. Chats are independent persisted
sessions rather than filters over one global transcript. `/new` starts without
old context, while `/fork` copies the current context into a new chat with a
fresh cost ledger.

Every model request receives the exact selected model ID and OpenRouter route in
its system instructions. RouterCode is instructed to identify itself as the
user's independent local CLI using that model, never as Codex, ChatGPT, Claude
Code, or a product created by the underlying model provider.

## Local state

Non-secret personal configuration and sessions live under:

```text
~/.routercode/
├── config.json
├── chats/
│   └── <workspace-id>/
│       └── <chat-id>.json
└── sessions/              # unveränderte Legacy-Dateien
```

Files are created with user-only permissions where supported. Sessions contain
conversation text, compressed handoffs, timestamps, and costs, but never the API
key. The first start migrates an old one-file-per-workspace session into the
chat directory without deleting or overwriting the legacy file.

## Development

```bash
npm run check
npm run build
node dist/cli.js --help
```

The tests do not call a paid model. They cover approval and balance gates, key
redaction, compression decisions, picker interaction, fixed dashboard layout,
secret rendering, terminal-control sanitization, cancellation, workspace
traversal, symlink escape, file-edit undo, and the catastrophic-command block.
