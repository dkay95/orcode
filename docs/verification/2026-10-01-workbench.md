# orcode GUI workbench — 2026-10-01

## Scope

This is a GUI-only improvement of the current desktop development snapshot.
It does not change the engine, protocol, account permissions, provider login,
automatic account failover, or the independent Architect/Cross workflows.

- Project context above the session list, not hidden in the status bar.
- Dark graphite / Route Core amber, larger readable body copy, structured controls.
- Real task actions: `/architect` and `/cross`, with an explicit captured composer draft.
- Event-only file changes and tool executions, inspectable without leaving the conversation.
- `/diff`, `/verify now`, and engine-authorized `/undo` actions.
- Inspector panel on wide windows, recoverable drawer on smaller supported windows.
- Cross preflight explains coding and review roles; models remain owner-selected.
- No fabricated task plan, tests, live Git state, or successful provider connection.

## Location and integration boundary

The original desktop source worktree was not writable in this session;
its requested write permission was not granted.
The original checkout and installed native application were not changed.

Implementation was verified in an isolated writable copy. The public development
branch imports its source tree on top of the public 0.4.0 history, without local
snapshot ancestry or private collaboration files. See `DEVELOPMENT.md`.
Integration into an existing local source worktree still requires a checked diff;
do not overwrite unrelated newer source changes.

## Verification

- Root engine build: passed.
- GUI production TypeScript and Vite build: passed.
- Final GUI suite: 261/261 passed, including the isolated preview smoke test.
- Independent read-only review: focused 72/72 passed; no outstanding critical or important findings.
- `git diff --check`: passed.
- TDD: initial workbench integration 5 RED → 5 GREEN; four additional lifecycle/draft regression cases RED → GREEN.
- Inspector unit behaviors: 17 RED → 17 GREEN.
- Real local engine protocol smoke: 5/5, with an isolated test home and no real provider login.
- Demo startup/command restoration: passed in the DOM test environment; portable preview export built.

Browser geometry and native app interaction are NOT verified in this session.
The Playwright Chrome launch was blocked by macOS sandbox permissions before tests ran.
The new browser regression file remains available for a permitted environment.
DOM tests do not prove CSS geometry or native Tauri usability.
No fresh provider execution, paid API call, package signing, native rebuild, or release publication.

## Visual preview

`gui/workbench-preview.html` uses an isolated DemoBridge and the production GUI renderer.
It is explicitly labelled as a demo. All displayed accounts, files, output, and command effects
are fixtures; no real model or filesystem operation runs.

From this copy:

```sh
npm --prefix gui run dev -- --port 1429
```

Open `http://127.0.0.1:1429/workbench-preview.html` in a local browser.
Portable offline HTML can be regenerated with:

```sh
cd gui
node_modules/.bin/vite build --config vite.preview.config.ts
node preview/export-preview.mjs /absolute/path/orcode-workbench-preview.html
```

## Still required before calling this installed/ready

1. Grant write access and integrate only the checked GUI diff into the source worktree.
2. Run the browser suite and inspect wide/minimum-width windows visually.
3. Rebuild and test the native app, including the real owner provider/login journeys.
4. Resolve the previously documented product and release gates separately.

Known backend boundary: Architect does not currently pass the ordinary run observers/
interjection handlers through its adapter. The fixture interjection regression protects
reported active runs; it does not prove live Architect interjection support.
