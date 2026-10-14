import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,lstat,realpath,readdir,open,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {WorkspaceGuard,ChangeJournal,type GuardedWorkspaceFileEffect} from './workspace.js';
import {copyLocalWorkspace,readLocalWorkspaceBaseline,snapshotCodexTree} from './codex-staging-workspace.js';
import {enableLocalIsolation,setLocalIsolationStopped,registerStoppedLocalIsolation} from './local-process-isolation.js';
type Phase='prepared'|'running'|'review'|'awaiting-apply'|'applied'|'blocked'|'stopped';
type File={bytes:Buffer;mode:number};
export interface LocalCandidate {id:string;originalRoot:string;workRoot:string;baselineHash:string;
  candidateHash:string;phase:Phase;stopEpoch:number;testedHash:string|null;
  changes:readonly {path:string;kind:'add'|'update'|'delete'}[];}
const publications=new WeakMap<object,{guard:WorkspaceGuard;effects:readonly GuardedWorkspaceFileEffect[];assertEffectCurrent:()=>void}>();
const applying=new Set<string>();
function hash(files:ReadonlyMap<string,File>):string {
  return createHash('sha256').update(JSON.stringify([...files].sort(([a],[b])=>a.localeCompare(b))
    .map(([path,f])=>[path,(f.mode&0o100)!==0,createHash('sha256').update(f.bytes).digest('hex')]))).digest('hex');
}
export function consumeLocalPublication(authority:object,guard:WorkspaceGuard):{effects:readonly GuardedWorkspaceFileEffect[];assertEffectCurrent:()=>void} {
  const entry=publications.get(authority); publications.delete(authority);
  if (!entry || entry.guard !== guard) throw new Error('invalid-local-publication');
  entry.assertEffectCurrent();return {effects:entry.effects,assertEffectCurrent:entry.assertEffectCurrent};
}
async function scan(root:string):Promise<Map<string,File>> {
  const snapshot=await snapshotCodexTree(root); const files=new Map<string,File>();
  for (const entry of snapshot.entries) if(entry.kind==='file') {
    const bytes=await readFile(join(root,entry.path));
    if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error('candidate-changed-during-scan');
    files.set(entry.path,{bytes,mode:entry.mode});
  }
  return files;
}
export class LocalProjectRun {
  #persistence:Promise<void>=Promise.resolve();
  private constructor(private state:LocalCandidate,private baseline:Map<string,File>,
    readonly journalPath:string,private appHome:string,private sessionId:string) {}
  static async create(input:{originalRoot:string;appHome:string;sessionId?:string;signal?:AbortSignal}):Promise<LocalProjectRun> {
    input.signal?.throwIfAborted();
    const original=await WorkspaceGuard.create(input.originalRoot),appHome=await realpath(input.appHome);
    const homeInfo=await lstat(appHome); if((homeInfo.mode&0o077)!==0)throw new Error('local-journal-home-not-private');
    const runs=join(appHome,'local-runs');await mkdir(runs,{recursive:true,mode:0o700});
    const runDirectory=await mkdtemp(join(runs,'run-')); const workRoot=join(runDirectory,'work');
    await mkdir(workRoot,{mode:0o700});
    const files=await copyLocalWorkspace({source:original,destination:workRoot,appHome});
    const baseline=new Map([...files].map(([path,file])=>[path,{bytes:Buffer.from(file.bytes),mode:file.mode}]));
    const candidate=hash(await scan(workRoot));
    const run=new LocalProjectRun({id:randomUUID(),originalRoot:original.canonicalRoot,workRoot,
      baselineHash:hash(baseline),candidateHash:candidate,phase:'prepared',stopEpoch:1,testedHash:null,changes:[]},
      baseline,join(runDirectory,'run.json'),appHome,input.sessionId??'standalone');
    await run.persist();
    try{await enableLocalIsolation(workRoot,input.signal);}catch(error){
      if(!input.signal?.aborted)throw error;
      await run.stop();await registerStoppedLocalIsolation(workRoot);
    }
    return run;
  }
  static async recover(journalPath:string):Promise<LocalProjectRun> {
    const info=await lstat(journalPath);
    if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw new Error('invalid-local-journal');
    const saved=JSON.parse(await readFile(journalPath,'utf8')) as {state:LocalCandidate;appHome:string;sessionId:string;files:[string,string,number][]};
    const expected=join(dirname(journalPath),'work');
    if(saved.state.workRoot!==expected||await realpath(expected)!==expected)throw new Error('local-journal-root-changed');
    const run=new LocalProjectRun(saved.state,new Map(saved.files.map(([path,bytes,mode])=>[path,{bytes:Buffer.from(bytes,'base64'),mode}])),journalPath,saved.appHome,saved.sessionId??'standalone');
    // A crashed/running session never restarts itself. Explicit resume is required.
    run.state={...run.state,phase:'stopped',stopEpoch:run.state.stopEpoch+1,testedHash:null};
    await run.persist(); await registerStoppedLocalIsolation(expected);return run;
  }
  static async restoreLatest(input:{appHome:string;sessionId:string;originalRoot:string}):Promise<LocalProjectRun|null> {
    const appHome=await realpath(input.appHome),root=join(appHome,'local-runs');
    let names:string[];try{names=await readdir(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    const rootInfo=await lstat(root);
    if(rootInfo.isSymbolicLink()||await realpath(root)!==root||(rootInfo.mode&0o077)!==0)throw new Error('local-run-directory-untrusted');
    const candidates:{path:string;modified:number}[]=[];
    for(const name of names.slice(0,128)) {
      if(!/^run-[a-zA-Z0-9]+$/.test(name))continue;
      const directory=join(root,name),path=join(directory,'run.json');
      try{
        const dirInfo=await lstat(directory),info=await lstat(path);
        if(dirInfo.isSymbolicLink()||await realpath(directory)!==directory||(dirInfo.mode&0o077)!==0
          ||!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o077)!==0||info.size>720*1024*1024)continue;
        const saved=JSON.parse(await readFile(path,'utf8')) as {sessionId?:string;appHome?:string;state?:LocalCandidate};
        if(saved.sessionId===input.sessionId&&saved.appHome===appHome&&saved.state?.originalRoot===await realpath(input.originalRoot)
          &&saved.state.workRoot===join(directory,'work')&&saved.state.phase!=='applied') candidates.push({path,modified:info.mtimeMs});
      }catch{/* Broken or retired artifact never authorizes work. */}
    }
    candidates.sort((a,b)=>b.modified-a.modified);
    return candidates[0]?LocalProjectRun.recover(candidates[0].path):null;
  }
  view():LocalCandidate {return {...this.state,changes:this.state.changes.map(c=>({...c}))};}
  assertStart(epoch:number):void {
    if(this.state.phase==='stopped'||this.state.phase==='applied'||epoch!==this.state.stopEpoch)throw new Error('local-start-retired');
  }
  async start(epoch:number):Promise<void> {this.assertStart(epoch);this.state={...this.state,phase:'running',testedHash:null};await this.persist();}
  async stop():Promise<void> {this.state={...this.state,phase:'stopped',stopEpoch:this.state.stopEpoch+1,testedHash:null};
    setLocalIsolationStopped(this.state.workRoot,true);await this.persist();}
  async resume(signal?:AbortSignal):Promise<void> {if(this.state.phase!=='stopped')throw new Error('resume-not-required');
    const epoch=this.state.stopEpoch;
    await enableLocalIsolation(this.state.workRoot,signal);
    if(signal?.aborted||this.state.stopEpoch!==epoch||this.state.phase!=='stopped'){
      setLocalIsolationStopped(this.state.workRoot,true);throw new Error('resume-retired');
    }
    this.state={...this.state,phase:'prepared',stopEpoch:this.state.stopEpoch+1};await this.persist();}
  async review():Promise<LocalCandidate> {
    const epoch=this.state.stopEpoch;
    this.assertStart(epoch); const files=await scan(this.state.workRoot);
    const changes:LocalCandidate['changes'][number][]=[];
    for(const path of new Set([...this.baseline.keys(),...files.keys()])) {
      const before=this.baseline.get(path),after=files.get(path);
      if(!before)changes.push({path,kind:'add'});else if(!after)changes.push({path,kind:'delete'});
      else {
        if((before.mode&0o100)!==(after.mode&0o100))throw new Error('candidate-mode-change-unsupported');
        if(!before.bytes.equals(after.bytes))changes.push({path,kind:'update'});
      }
    }
    const candidateHash=hash(files);
    this.assertStart(epoch);
    this.state={...this.state,candidateHash,changes,phase:'review',
      testedHash:this.state.testedHash===candidateHash ? candidateHash:null};await this.persist();return this.view();
  }
  async markTested(candidateHash:string,passed:boolean):Promise<void> {
    const epoch=this.state.stopEpoch;this.assertStart(epoch);
    const current=await this.review();if(current.candidateHash!==candidateHash)throw new Error('tested-candidate-changed');
    this.assertStart(epoch);
    this.state={...this.state,testedHash:passed?candidateHash:null,phase:passed?'awaiting-apply':'review'};await this.persist();
  }
  async apply(candidateHash:string,options:{confirmed:boolean;beforePublish?:()=>void}):Promise<void> {
    if(!options.confirmed||this.state.phase!=='awaiting-apply'||this.state.testedHash!==candidateHash)throw new Error('apply-needs-tested-confirmed-candidate');
    if(applying.has(this.state.originalRoot))throw new Error('apply-already-active');applying.add(this.state.originalRoot);
    try {
      const epoch=this.state.stopEpoch;
      const assertEffectCurrent=()=>{this.assertStart(epoch);if(this.state.testedHash!==candidateHash)throw new Error('apply-grant-retired');};
      assertEffectCurrent();
      const files=await scan(this.state.workRoot);if(hash(files)!==candidateHash)throw new Error('candidate-changed');
      const originalFiles=await readLocalWorkspaceBaseline({source:await WorkspaceGuard.create(this.state.originalRoot),appHome:this.appHome});
      if(hash(originalFiles)!==this.state.baselineHash)throw new Error('original-baseline-changed');
      const guard=await WorkspaceGuard.create(this.state.originalRoot);
      const effects=this.state.changes.map(change=>({path:change.path,before:this.baseline.get(change.path)?.bytes??null,
        after:files.get(change.path)?.bytes??null,...(this.baseline.has(change.path)?{beforeMode:this.baseline.get(change.path)!.mode}:{}),
        createdMode:((files.get(change.path)?.mode??0)&0o100)!==0?0o700:0o600}));
      options.beforePublish?.();assertEffectCurrent();
      const authority=Object.freeze({}); publications.set(authority,{guard,effects,assertEffectCurrent});
      await this.persist(); // durable pre-images before any original write
      const journal=new ChangeJournal({appHome:this.appHome,chatId:this.state.id});
      await guard.publishLocalCandidateEffects(authority,journal,this.state.id);
      this.state={...this.state,phase:'applied'};setLocalIsolationStopped(this.state.workRoot,true);await this.persist();
    } catch(error) {if(this.state.phase!=='stopped')this.state={...this.state,phase:'blocked'};await this.persist();throw error;}
    finally{applying.delete(this.state.originalRoot);}
  }
  private async persist():Promise<void> {
    const write=this.#persistence.catch(()=>{}).then(async()=>{
      const directory=dirname(this.journalPath);
      if(await realpath(directory)!==directory)throw new Error('local-journal-directory-changed');
      const temporary=join(directory,`.run-journal-${randomUUID()}`);
      const handle=await open(temporary,'wx',0o600);
      try{
        await handle.writeFile(JSON.stringify({state:this.state,appHome:this.appHome,sessionId:this.sessionId,
          files:[...this.baseline].map(([path,f])=>[path,f.bytes.toString('base64'),f.mode])}));
        await handle.sync();
      }finally{await handle.close();}
      await rename(temporary,this.journalPath);
      const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
    });
    this.#persistence=write;await write;
  }
}
