import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectClaudeAccount,projectCodexLoginStatus, parseManufacturerVersion } from '../src/official-cli-host.js';

test('manufacturer versions are closed and do not publish process chatter', () => {
  assert.equal(parseManufacturerVersion('claude','2.1.289 (Claude Code)\n'), '2.1.289');
  assert.equal(parseManufacturerVersion('codex','codex-cli 0.159.1\n'), '0.159.1');
  assert.equal(parseManufacturerVersion('claude','token-secret 2.1.289'), null);
});
test('Codex default CLI login is separate from paid plan and GUI route',()=>{
  assert.deepEqual(projectCodexLoginStatus('Logged in using ChatGPT\n'),
    {authenticated:true,subscription:null,runnableInGui:false});
  assert.deepEqual(projectCodexLoginStatus('Not logged in\n'),
    {authenticated:false,subscription:null,runnableInGui:false});
  assert.deepEqual(projectCodexLoginStatus('something with private identity'),
    {authenticated:null,subscription:null,runnableInGui:false});
});
test('Claude status publishes only authentication/subscription, never identity', () => {
  assert.deepEqual(projectClaudeAccount(JSON.stringify({loggedIn:true, authMethod:'claude.ai',
    subscriptionType:'max', email:'private@example.org', apiKey:'secret'})),
  {authenticated:true,subscription:true,runnableInGui:false});
  assert.deepEqual(projectClaudeAccount(JSON.stringify({loggedIn:true, authMethod:'api_key'})),
    {authenticated:true,subscription:false,runnableInGui:false});
  assert.deepEqual(projectClaudeAccount('invalid secret output'),
    {authenticated:null,subscription:null,runnableInGui:false});
});
