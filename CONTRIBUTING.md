# Contributing to orcode

Thanks for considering a contribution. orcode is a small TypeScript
(ESM, Node 22+) project; the workflow is intentionally simple.

## Setup

```bash
git clone https://github.com/dkay95/orcode.git
cd orcode
npm install
```

Copy `.env.example` to `.env` if you want to set `OPENROUTER_API_KEY` /
`OPENROUTER_MANAGEMENT_KEY` for manual testing. Never commit a real key.

## Build, typecheck, test

```bash
npm run build   # compile src/ to dist/
npm run dev     # run the CLI from source with tsx, no build step
npm test        # run the test suite (tests/*.test.ts)
npm run check   # both tsconfig typechecks (source + tests) + npm test
```

### Working from a local clone without publishing

If you want a `orcode` command on your `PATH` that always points at your
working copy (instead of installing the published package), use:

```bash
npm run install:user
```

This builds the project and creates a symlink at `~/.local/bin/orcode`
pointing into your clone's `dist/`, via `scripts/install-user.mjs`. It
refuses to overwrite an unrelated existing file or link, and it currently
assumes a Unix-style symlink and `~/.local/bin` on `PATH`, so it is a
developer convenience, not a supported end-user install path — that's why it
is not included in the published npm package (see `files` in
`package.json`) and not documented in the README. End users should use
`npx orcode` or `npm install -g orcode` instead.

Run `npm run check` before opening a pull request. It must pass; CI runs the
same command on Linux, macOS, and Windows against Node 22.

The test suite never calls a paid model. Tests cover approval and budget
gates, key redaction, compression decisions, picker interaction, the fixed
dashboard layout, secret rendering, terminal-control sanitization,
cancellation, workspace traversal, symlink-escape protection, file-edit
undo, and the catastrophic-command block. If you add behavior, add or extend
a test for it rather than relying on manual verification alone.

## Conventions

- **Tests are flat.** All tests live directly under `tests/`, named
  `<module>.test.ts`, mirroring the `src/` module they cover. Do not nest
  test directories or split a module's tests across multiple files without
  a good reason.
- **No new dependencies without a reason.** orcode deliberately keeps a
  small, audited dependency tree (see `NOTICE`). Before adding a package,
  check whether the standard library or an existing dependency already
  covers the need, and be ready to explain the addition in the pull
  request description.
- **User-facing text goes through the language layer.** orcode supports
  both German and English runtime text. Do not hardcode user-facing strings
  directly in a command handler or UI component; add them through the
  project's language/translation layer so both languages stay in sync. Code
  comments and internal documentation can be in either language, but a
  single file should stay consistent.
- **Never write secrets to disk.** The OpenRouter API key must never end up
  in `~/.orcode/`, a log file, a run-log event, or a test fixture. If
  you touch key handling, credential storage, or the shell-tool environment
  sanitization, double-check the redaction tests still cover your change.
- **Slash commands are documented in one place.** `src/command-catalog.ts`
  is the single source of truth for command names, aliases, and usage — it
  drives both `/help` and the interactive command palette. Add new commands
  there, not just in the handler.

## Reporting issues

Please include your OS, Node version, orcode version (`orcode
--version` if available, or the `package.json` version you installed), the
approval mode you were using, and steps to reproduce. Do not paste your
OpenRouter API key into an issue.

## Security

If you find a vulnerability (for example, a workspace escape, a sandbox
bypass, or a way the API key could leak), please do not open a public issue.
Use the repository's private security-advisory reporting instead.
