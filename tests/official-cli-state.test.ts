import assert from 'node:assert/strict';
import test from 'node:test';
import { cliReady, cliPresentation, emptyOfficialCliState, acceptCliObservation } from '../src/official-cli-state.js';

test('installation alone never enables a GUI subscription route', () => {
  const state = {...emptyOfficialCliState('codex', 1), installed:'yes' as const, version:'0.159.1'};
  assert.equal(cliReady(state), false);
  assert.equal(cliPresentation(state).action, 'check');
});

test('missing CLI offers install rather than login', () => {
  const state = {...emptyOfficialCliState('claude', 1), installed:'no' as const};
  assert.equal(cliPresentation(state).action, 'install');
  assert.equal(cliReady(state), false);
});

test('unsupported installed version is not replaced by automatic install', () => {
  const state = {...emptyOfficialCliState('codex', 1), installed:'yes' as const,
    version:'0.159.1', compatible:'no' as const};
  const view = cliPresentation(state);
  assert.equal(view.action, 'open-external');
  assert.equal(view.ready, false);
  assert.match(view.reason, /Version/);
});

test('verified login without subscription entitlement remains unavailable', () => {
  const state = {...emptyOfficialCliState('claude', 1), installed:'yes' as const,
    compatible:'yes' as const, authenticated:'yes' as const,
    subscription:'no' as const, runnableInGui:'yes' as const};
  assert.equal(cliReady(state), false);
  assert.equal(cliPresentation(state).action, 'open-external');
});

test('known logged-out CLI offers manufacturer login', () => {
  const state = {...emptyOfficialCliState('claude', 1), installed:'yes' as const,
    compatible:'yes' as const, authenticated:'no' as const};
  assert.equal(cliPresentation(state).action, 'login');
});

test('external-only authenticated CLI never pretends to be a GUI adapter', () => {
  const state = {...emptyOfficialCliState('kimi', 1), installed:'yes' as const,
    compatible:'yes' as const, authenticated:'yes' as const,
    subscription:'yes' as const, runnableInGui:'no' as const};
  assert.equal(cliPresentation(state).action, 'open-external');
  assert.equal(cliReady(state), false);
});

test('all five verified prerequisites enable GUI use', () => {
  const state = {...emptyOfficialCliState('codex', 1), installed:'yes' as const,
    compatible:'yes' as const, authenticated:'yes' as const,
    subscription:'yes' as const, runnableInGui:'yes' as const};
  assert.equal(cliReady(state), true);
  assert.equal(cliPresentation(state).ready, true);
});

test('stale or wrong-provider observations cannot replace current CLI state', () => {
  const current = {...emptyOfficialCliState('codex', 4), installed:'yes' as const};
  assert.equal(acceptCliObservation(current, emptyOfficialCliState('codex', 3)), current);
  assert.equal(acceptCliObservation(current, emptyOfficialCliState('claude', 4)), current);
  assert.equal(acceptCliObservation(current, emptyOfficialCliState('codex', 5)), current);
});

test('cancelled observation retains a previously valid route', () => {
  const current = {...emptyOfficialCliState('codex', 4), installed:'yes' as const,
    compatible:'yes' as const, authenticated:'yes' as const,
    subscription:'yes' as const, runnableInGui:'yes' as const};
  const cancelled = {...emptyOfficialCliState('codex', 4), outcome:'cancelled' as const};
  assert.equal(acceptCliObservation(current, cancelled), current);
  assert.equal(cliReady(current), true);
});
