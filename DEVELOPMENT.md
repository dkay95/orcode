# Development snapshot: Route Core workbench

This is an **unreleased development branch**, not a replacement for the stable
GitHub release. It consolidates the existing 0.7 CLI/desktop development tree
and the 2026-10-01 GUI workbench update.

The branch starts from the public `main` revision `08996fa2` (0.4.0). It imports
source files only. Local development ancestry, brainstorming state, collaboration
handoffs, private app homes, credentials, dependencies, and build output are not
included. The original local repositories remain unchanged.

## What is included

- Project and session navigation, with project context visible at the top.
- A more readable graphite/amber Route Core desktop UI.
- One primary task action, with Plan and two-model Coding/Review in a secondary menu.
- Searchable, explicitly confirmed model/account selection; no automatic model choice.
- Collapsible project/chat navigation and compact-window drawers with keyboard focus containment.
- A changes/execution inspector driven by structured engine events.
- Real `/diff`, `/verify now`, and engine-authorized `/undo` controls.
- Draft-restoration and window lifecycle/focus regression fixes.
- An isolated demo preview, labelled as such; it does not call providers or change files.

## Current verification boundary — 2026-10-12

This is a WIP upload, **not an all-green or release-ready baseline**.

- Root production build and test TypeScript check: passed.
- GUI production build: passed.
- GUI unit/integration suite after the simplification: 276/276 passed.
- Latest full default Core run during this work: 4,452 tests, 4,358 passed,
  93 failed, 1 skipped. This is not a passing release gate.
- An earlier run with a machine-readable reporter identified 89 failing
  cases: 88 fail at the Codex version trust precondition and one at config-writer
  ownership verification. The second run is not presented as passing either.
- The Mac's system test wrapper is Codex 0.159.1. The integration's explicit
  trust policy and several integration tests require the signed 0.142.5 payload.
  Tests resolving that system installation fail before their protocol scenarios.
- The production GUI rendered through the isolated demo was inspected at 648px:
  navigation opening, Tab/Shift+Tab containment, Escape/focus return, model search
  and separate manual confirmation, the secondary menu, and the changes drawer.
- Independent review found two focus/disclosure regressions; both were fixed and
  re-reviewed. Live updates now preserve opened disclosure nodes and keyboard focus.
- Wide-window visual acceptance, native app acceptance, and real account login
  remain unverified. The demo is not evidence of a real provider connection.

The system Codex installation was not downgraded, and the production trust or
ownership checks were not relaxed to obtain passing tests. Updating this adapter
against a supported current runtime, making integration prerequisites reproducible,
and verifying the config-writer case in a permitted environment are open work.

The public snapshot is useful for code review and continuing development; do not
mistake its GUI tests or build success for working native Codex login.

## Verify locally

Requires Node.js 22+ and the development dependencies:

```sh
npm ci
npm --prefix gui ci
npm run build
npm --prefix gui run build
env -u FORCE_COLOR npm test
env -u FORCE_COLOR npm --prefix gui test
```

The browser suite needs a permitted Chromium/Chrome installation:

```sh
npm --prefix gui run test:browser
```

For the visual demo:

```sh
npm --prefix gui run dev -- --port 1430
```

Open `http://127.0.0.1:1430/workbench-preview.html` locally. The model picker uses
two synthetic Demo models/accounts and changes only local preview state. Account labels,
file changes, command results, and test output are illustrative fixtures only.

## Remaining product gates

- Extend the compact demo checks to wide-window geometry and real owner workflows.
- Rebuild and test the native Tauri application rather than assuming the web preview proves it.
- Verify the actual owner's supported login/provider journeys; no live login is proven by this snapshot.
- Continue the task/context/workflow consolidation identified in the product audit.
- Complete release signing, packaging, and acceptance before a 0.7 tag or release.

Architect currently has its own adapter and does not expose the ordinary agent's
run observers/interjection handlers. Fixture interjection coverage does not prove
live Architect interjection support.

No merge to `main`, release tag, package publication, or native installation is
authorized or performed as part of publishing this development branch.
