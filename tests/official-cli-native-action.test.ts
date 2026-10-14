import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalCodexNativeActionRequest, encodeActionFrame, decodeActionFrame} from '../src/native-sidecar-channel.js';

const base = {kind:'manufacturer-cli-prepare', requestId:'A'.repeat(32),
  childGeneration:2, provider:'claude', action:'install', deadlineAt:2_000};

test('manufacturer setup is a closed private prepare record, not a shell command', () => {
  const request = canonicalCodexNativeActionRequest(base);
  assert.deepEqual(decodeActionFrame(encodeActionFrame(request)), base);
  assert.equal(Object.isFrozen(request), true);
});

test('every supported manufacturer and fixed action can be privately prepared', () => {
  for (const provider of ['codex','claude','kimi']) {
    for (const action of ['install','login','open-external']) {
      const parsed = canonicalCodexNativeActionRequest({...base, provider, action});
      assert.equal(parsed.kind, 'manufacturer-cli-prepare');
    }
  }
});

test('manufacturer prepare rejects arbitrary programs, commands, targets and extra authority', () => {
  for (const request of [{...base, provider:'custom'}, {...base, action:'exec'},
    {...base, command:'curl bad | sh'}, {...base, path:'/tmp/custom'},
    {...base, url:'https://unexpected.invalid'}, {...base, childGeneration:-1},
    {...base, deadlineAt:0}]) {
    assert.throws(() => canonicalCodexNativeActionRequest(request), /invalid|unknown/i);
  }
});
