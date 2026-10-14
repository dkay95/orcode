import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,link,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {LocalProjectRun} from '../src/local-project-run.js';

async function fixture() {
  const base=await mkdtemp(join(tmpdir(),'orcode-local-run-'));
  const original=join(base,'project'),appHome=join(base,'app');
  await mkdir(original); await mkdir(appHome,{mode:0o700});
  await writeFile(join(original,'dirty.txt'),'uncommitted original');
  return {original,appHome};
}
test('local work is separate, tests bind exact bytes and apply preserves dirty baseline',async()=>{
  const {original,appHome}=await fixture(); const run=await LocalProjectRun.create({originalRoot:original,appHome});
  await writeFile(join(run.view().workRoot,'dirty.txt'),'candidate');
  assert.equal(await readFile(join(original,'dirty.txt'),'utf8'),'uncommitted original');
  const candidate=await run.review();
  assert.equal(candidate.changes.length,1);
  await run.markTested(candidate.candidateHash,true);
  await run.apply(candidate.candidateHash,{confirmed:true});
  assert.equal(await readFile(join(original,'dirty.txt'),'utf8'),'candidate');
  assert.equal(run.view().phase,'applied');
});
test('changed original or changed candidate blocks Apply',async()=>{
  for (const target of ['original','candidate']) {
    const {original,appHome}=await fixture(); const run=await LocalProjectRun.create({originalRoot:original,appHome});
    await writeFile(join(run.view().workRoot,'dirty.txt'),'candidate');
    const candidate=await run.review(); await run.markTested(candidate.candidateHash,true);
    await writeFile(join(target==='original'?original:run.view().workRoot,'dirty.txt'),'foreign change');
    await assert.rejects(run.apply(candidate.candidateHash,{confirmed:true}));
    assert.equal(await readFile(join(original,'dirty.txt'),'utf8'),target==='original'?'foreign change':'uncommitted original');
  }
});
test('Stop survives recovery; old epoch cannot dispatch until explicit resume',async()=>{
  const {original,appHome}=await fixture(); const run=await LocalProjectRun.create({originalRoot:original,appHome});
  const epoch=run.view().stopEpoch; await run.stop();
  const restored=await LocalProjectRun.recover(run.journalPath);
  assert.throws(()=>restored.assertStart(epoch));
  await restored.resume(); assert.throws(()=>restored.assertStart(epoch));
  restored.assertStart(restored.view().stopEpoch);
});
test('hardlink candidates and an injected original edit are rejected without overwriting it',async()=>{
  const {original,appHome}=await fixture(); const run=await LocalProjectRun.create({originalRoot:original,appHome});
  await link(join(original,'dirty.txt'),join(run.view().workRoot,'alias.txt'));
  await assert.rejects(run.review());
});
test('a foreign writer between validation and effect is preserved',async()=>{
  const {original,appHome}=await fixture(); const run=await LocalProjectRun.create({originalRoot:original,appHome});
  await writeFile(join(run.view().workRoot,'dirty.txt'),'candidate');
  const candidate=await run.review();await run.markTested(candidate.candidateHash,true);
  await assert.rejects(run.apply(candidate.candidateHash,{confirmed:true,
    beforePublish:()=>writeFileSync(join(original,'dirty.txt'),'foreign between checks')}));
  assert.equal(await readFile(join(original,'dirty.txt'),'utf8'),'foreign between checks');
});
test('a new original file invalidates the whole baseline',async()=>{
  const {original,appHome}=await fixture();const run=await LocalProjectRun.create({originalRoot:original,appHome});
  await writeFile(join(run.view().workRoot,'dirty.txt'),'candidate');
  const candidate=await run.review();await run.markTested(candidate.candidateHash,true);
  await writeFile(join(original,'new-foreign-config.json'),'foreign');
  await assert.rejects(run.apply(candidate.candidateHash,{confirmed:true}));
  assert.equal(await readFile(join(original,'dirty.txt'),'utf8'),'uncommitted original');
});
test('Stop during Apply cannot be replaced by blocked and restarted implicitly',async()=>{
  const {original,appHome}=await fixture();const run=await LocalProjectRun.create({originalRoot:original,appHome});
  await writeFile(join(run.view().workRoot,'dirty.txt'),'candidate');
  const candidate=await run.review();await run.markTested(candidate.candidateHash,true);
  let stopping:Promise<void>|undefined;
  await assert.rejects(run.apply(candidate.candidateHash,{confirmed:true,beforePublish:()=>{stopping=run.stop();}}));
  await stopping;
  assert.equal(run.view().phase,'stopped');assert.throws(()=>run.assertStart(run.view().stopEpoch));
});
test('session discovery restores the saved candidate stopped, never as a worker',async()=>{
  const {original,appHome}=await fixture();const run=await LocalProjectRun.create({originalRoot:original,appHome,sessionId:'session'});
  const recovered=await LocalProjectRun.restoreLatest({appHome,originalRoot:original,sessionId:'session'});
  assert.equal(recovered?.view().id,run.view().id);assert.equal(recovered?.view().phase,'stopped');
  assert.equal(await LocalProjectRun.restoreLatest({appHome,originalRoot:original,sessionId:'other'}),null);
});
test('a late review or test completion cannot resurrect Stop',async()=>{
  for(const operation of ['review','test']){
    const {original,appHome}=await fixture();const run=await LocalProjectRun.create({originalRoot:original,appHome});
    const pending=operation==='review'?run.review():run.markTested(run.view().candidateHash,true);
    const rejected=assert.rejects(pending);await run.stop();await rejected;
    assert.equal(run.view().phase,'stopped');assert.throws(()=>run.assertStart(run.view().stopEpoch));
  }
});
test('new files and deletions publish as exact candidate effects',async()=>{
  const {original,appHome}=await fixture();const run=await LocalProjectRun.create({originalRoot:original,appHome});
  await writeFile(join(run.view().workRoot,'new.txt'),'new\n',{mode:0o600});
  await unlink(join(run.view().workRoot,'dirty.txt'));
  const candidate=await run.review();await run.markTested(candidate.candidateHash,true);
  await run.apply(candidate.candidateHash,{confirmed:true});
  assert.equal(await readFile(join(original,'new.txt'),'utf8'),'new\n');
  await assert.rejects(readFile(join(original,'dirty.txt')),{code:'ENOENT'});
});
