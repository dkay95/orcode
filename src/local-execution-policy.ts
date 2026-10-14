export interface LocalExecutionPolicy {aiProcess:'manual'|'auto';permissions:'ask'|'automatic';revision:number;}
export interface LocalRunGrant {id:string;revision:number;revoked:boolean;workRoot:string;
  allowedRouteHandles:readonly string[];allowedActions:readonly ('read'|'edit'|'test'|'apply')[];extraCostLimitUsd:number;}
export function updateLocalPolicy(policy:LocalExecutionPolicy,key:'aiProcess'|'permissions',value:string,
  expectedRevision:number):LocalExecutionPolicy {
  if(policy.revision!==expectedRevision)throw new Error('local-policy-stale');
  const choices=key==='aiProcess'?['manual','auto']:key==='permissions'?['ask','automatic']:[];
  if(!choices.includes(value))throw new Error('invalid-local-policy');
  return {...policy,[key]:value,revision:policy.revision+1};
}
export function assertLocalRunGrant(grant:LocalRunGrant,start:{revision:number;workRoot:string;
  routeHandle:string;action:'read'|'edit'|'test'|'apply';extraCostUsd:number}):void {
  if(grant.revoked||start.revision!==grant.revision||start.workRoot!==grant.workRoot
    ||!grant.allowedRouteHandles.includes(start.routeHandle)||!grant.allowedActions.includes(start.action)
    ||!Number.isFinite(start.extraCostUsd)||start.extraCostUsd<0||start.extraCostUsd>grant.extraCostLimitUsd) {
    throw new Error('local-run-grant-refused');
  }
}

/** A bounded local two-phase process; never changes the chosen lead route. */
export async function executeLocalFlow(policy:LocalExecutionPolicy,ports:{assertCurrent():void;
  plan():Promise<string>;approve(plan:string):Promise<boolean>;work(plan?:string):Promise<void>}):Promise<void> {
  ports.assertCurrent();
  if(policy.aiProcess==='manual'){await ports.work();return;}
  const plan=await ports.plan();ports.assertCurrent();
  if(policy.permissions==='ask'&&!await ports.approve(plan))return;
  ports.assertCurrent();await ports.work(plan);
}
