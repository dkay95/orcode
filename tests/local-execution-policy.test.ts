import {test} from 'node:test';
import assert from 'node:assert/strict';
import {updateLocalPolicy,assertLocalRunGrant,executeLocalFlow} from '../src/local-execution-policy.js';
test('AI process and permissions are independent, revision-bound switches',()=>{
  const initial={aiProcess:'manual',permissions:'ask',revision:1} as const;
  assert.equal(updateLocalPolicy(initial,'aiProcess','auto',1).permissions,'ask');
  assert.equal(updateLocalPolicy(initial,'permissions','automatic',1).aiProcess,'manual');
  assert.throws(()=>updateLocalPolicy(initial,'permissions','auto',1));
  assert.throws(()=>updateLocalPolicy(initial,'aiProcess','auto',0));
});
test('all four combinations keep planning separate from permission approval',async()=>{
  for(const aiProcess of ['manual','auto'] as const)for(const permissions of ['ask','automatic'] as const) {
    const events:string[]=[];
    await executeLocalFlow({aiProcess,permissions,revision:1},{
      assertCurrent:()=>{},plan:async()=>{events.push('plan');return 'plan';},
      approve:async()=>{events.push('approve');return true;},work:async()=>{events.push('work');}});
    assert.deepEqual(events,aiProcess==='manual'?['work']:permissions==='ask'?['plan','approve','work']:['plan','work']);
  }
});
test('revoked plan approval never starts a worker',async()=>{
  let current=true,worked=false;
  await assert.rejects(executeLocalFlow({aiProcess:'auto',permissions:'ask',revision:1},{
    assertCurrent:()=>{if(!current)throw new Error('retired');},plan:async()=>'plan',
    approve:async()=>{current=false;return true;},work:async()=>{worked=true;}}));
  assert.equal(worked,false);
});
test('starts consume current route, work root, action, cost and revocation',()=>{
  const grant={id:'grant',revision:2,revoked:false,workRoot:'/private/work',
    allowedRouteHandles:['chosen'],allowedActions:['read','edit','test'] as const,extraCostLimitUsd:0};
  const start={revision:2,workRoot:'/private/work',routeHandle:'chosen',action:'edit' as const,extraCostUsd:0};
  assert.doesNotThrow(()=>assertLocalRunGrant(grant,start));
  for(const altered of [{...start,routeHandle:'automatic-replacement'},{...start,revision:1},
    {...start,workRoot:'/original'},{...start,extraCostUsd:1},{...start,action:'apply' as const}])
    assert.throws(()=>assertLocalRunGrant(grant,altered));
  assert.throws(()=>assertLocalRunGrant({...grant,revoked:true},start));
});
