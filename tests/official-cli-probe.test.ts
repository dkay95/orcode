import assert from 'node:assert/strict';
import test from 'node:test';
import { probeOfficialCli, type OfficialCliProbePort } from '../src/official-cli-probe.js';

const trusted: OfficialCliProbePort = {
  async inspectInstallation() { return {installed:true, version:'0.159.1', compatible:true}; },
  async inspectAccount() { return {authenticated:true, subscription:true, runnableInGui:true}; },
};

test('missing manufacturer CLI does not start an account probe', async () => {
  const result = await probeOfficialCli('codex', 2, {
    async inspectInstallation() { return {installed:false, version:null, compatible:null}; },
    async inspectAccount() { assert.fail('must not query missing binary'); },
  });
  assert.equal(result.installed, 'no');
  assert.equal(result.authenticated, 'unknown');
  assert.equal(result.runnableInGui, 'no');
});

test('unsupported CLI version does not enter managed account commands', async () => {
  const result = await probeOfficialCli('codex', 2, {
    async inspectInstallation() { return {installed:true, version:'0.159.1', compatible:false}; },
    async inspectAccount() { assert.fail('must not use unsupported protocol'); },
  });
  assert.equal(result.compatible, 'no');
  assert.equal(result.authenticated, 'unknown');
});

test('successful trusted probe returns only public prerequisite facts', async () => {
  const result = await probeOfficialCli('codex', 2, trusted);
  assert.deepEqual(result, {provider:'codex', revision:2, installed:'yes',
    version:'0.159.1', compatible:'yes', authenticated:'yes', subscription:'yes',
    runnableInGui:'yes', outcome:'checked'});
});

test('API login is not promoted to subscription use', async () => {
  const result = await probeOfficialCli('claude', 1, {...trusted,
    async inspectAccount() { return {authenticated:true, subscription:false, runnableInGui:false}; },
  });
  assert.equal(result.authenticated, 'yes');
  assert.equal(result.subscription, 'no');
  assert.equal(result.runnableInGui, 'no');
});

test('probe failures never echo process output or secret-bearing errors', async () => {
  const result = await probeOfficialCli('claude', 1, {...trusted,
    async inspectAccount() { throw new Error('token=sk-private account=user@example.test'); },
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.authenticated, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /sk-private|example\.test|token/);
});

test('a hanging probe is bounded even when the native port ignores abort', async () => {
  let signal: AbortSignal | undefined;
  const result = await probeOfficialCli('codex', 1, {...trusted,
    async inspectInstallation(_provider, incoming) {
      signal = incoming;
      return await new Promise(() => {});
    },
  }, {timeoutMs:15});
  assert.equal(result.outcome, 'failed');
  assert.equal(signal?.aborted, true);
});

test('already cancelled inspection never starts a native command', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await probeOfficialCli('codex', 1, {
    async inspectInstallation() { assert.fail('no cancelled command'); },
    async inspectAccount() { assert.fail('no cancelled command'); },
  }, {signal:controller.signal});
  assert.equal(result.outcome, 'cancelled');
});

test('mid-check cancellation retires late native results', async () => {
  const controller = new AbortController();
  let finish!: (value: {installed:boolean; version:string; compatible:boolean}) => void;
  const inspection = probeOfficialCli('codex', 7, {...trusted,
    async inspectInstallation() { return await new Promise(resolve => {finish=resolve;}); },
    async inspectAccount() { assert.fail('late result must not start account check'); },
  }, {signal:controller.signal});
  controller.abort();
  const result = await inspection;
  finish({installed:true, version:'0.159.1', compatible:true});
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.authenticated, 'unknown');
});

test('unbounded or invalid deadlines are rejected before probing', async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 30_001]) {
    await assert.rejects(probeOfficialCli('codex', 1, trusted, {timeoutMs}), /invalid-cli-deadline/);
  }
});

test('malformed version text is never projected from native output', async () => {
  const result = await probeOfficialCli('claude', 1, {...trusted,
    async inspectInstallation() { return {installed:true, version:'2.1.289\napiKey=secret', compatible:true}; },
    async inspectAccount() { assert.fail('unknown version cannot be used'); },
  });
  assert.equal(result.version, null);
  assert.equal(result.compatible, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /apiKey|secret/);
});
