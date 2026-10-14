import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseOfficialCliRequest,GUI_PROTOCOL_VERSION} from '../src/gui-protocol.js';
test('manufacturer setup requests contain only closed actions and current epoch',() => {
  const request = {v:GUI_PROTOCOL_VERSION,t:'official-cli.action',provider:'claude',action:'login',revision:1,generation:2};
  assert.deepEqual(parseOfficialCliRequest(request),{provider:'claude',action:'login',revision:1,generation:2});
  for (const extra of [{...request,command:'rm something'},{...request,provider:'custom'},
    {...request,action:'exec'},{...request,revision:-1}]) assert.throws(()=>parseOfficialCliRequest(extra));
});
