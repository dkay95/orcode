import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {enableLocalIsolation,isolatedLaunch} from '../src/local-process-isolation.js';
test('actual process and descendant cannot overwrite absolute original', {skip:process.platform!=='darwin'},async()=>{
  const base=await mkdtemp(join(tmpdir(),'orcode-containment-'));
  const requested=join(base,'work'); await mkdir(requested); const work=await realpath(requested);
  const original=join(base,'original.txt');await writeFile(original,'original');
  await enableLocalIsolation(work);
  const launch=await isolatedLaunch(work,process.execPath,['-e',
    `require('fs').writeFileSync(${JSON.stringify(original)},'bad')`]);
  await assert.rejects(promisify(execFile)(launch.executable,launch.args,{cwd:work}));
  assert.equal(await readFile(original,'utf8'),'original');
  const good=await isolatedLaunch(work,process.execPath,['-e',"require('fs').writeFileSync('result.txt','ok')"]);
  await promisify(execFile)(good.executable,good.args,{cwd:work});
  assert.equal(await readFile(join(work,'result.txt'),'utf8'),'ok');
});
