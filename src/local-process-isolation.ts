import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,realpath,unlink,lstat} from 'node:fs/promises';
import {dirname,join,relative,sep} from 'node:path';
import {snapshotCodexTree} from './codex-staging-workspace.js';
const roots = new Map<string,{enabled:boolean;profile:string;dev:number;ino:number}>();
const quote = (value:string) => JSON.stringify(value);

/** Real containment canary before issuing the private process capability. */
export async function enableLocalIsolation(workRoot:string,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();
  if (process.platform !== 'darwin') throw new Error('local-isolation-unavailable');
  const root=await realpath(workRoot);
  if (root !== workRoot) throw new Error('noncanonical-work-root');
  await snapshotCodexTree(root); // rejects links, hardlinks, mounts and special files
  const profile=`(version 1)(deny default)(allow file-read*)(allow process-exec)(allow process-fork)(allow sysctl-read)(allow file-write* (subpath ${quote(root)}))(allow file-write-data (literal "/dev/null"))`;
  const probe=await mkdtemp(join(dirname(root),'isolation-'));
  const outside=join(probe,'protected'),inside=join(root,'.orcode-isolation-canary');
  await writeFile(outside,'protected',{mode:0o600});
  const source=`const fs=require('fs');fs.writeFileSync(${quote(inside)},'contained');try{fs.writeFileSync(${quote(outside)},'escape');process.exitCode=2}catch(e){if(e.code!=='EPERM'&&e.code!=='EACCES')throw e}`;
  await promisify(execFile)('/usr/bin/sandbox-exec',['-p',profile,process.execPath,'-e',source],
    {cwd:root,timeout:5_000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin'},...(signal?{signal}:{})});
  if (await readFile(outside,'utf8') !== 'protected' || await readFile(inside,'utf8') !== 'contained') {
    throw new Error('local-isolation-canary-failed');
  }
  await unlink(inside);
  signal?.throwIfAborted();const info=await lstat(root);
  roots.set(root,{profile,enabled:true,dev:info.dev,ino:info.ino});
}
/** Recovery never dispatches a process; only explicit Resume can prove/enable it. */
export async function registerStoppedLocalIsolation(workRoot:string):Promise<void> {
  if(await realpath(workRoot)!==workRoot)throw new Error('noncanonical-work-root');
  const info=await lstat(workRoot);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('local-root-changed');
  roots.set(workRoot,{enabled:false,profile:'',dev:info.dev,ino:info.ino});
}
export function setLocalIsolationStopped(workRoot:string,stopped:boolean):void {
  const entry=roots.get(workRoot); if(entry)entry.enabled=!stopped;
}
export function isLocalWorkRoot(path:string):boolean {
  return [...roots.keys()].some(root=>path===root || path.startsWith(root+sep));
}
export function assertLocalWorkEffect(root:string):void {
  const entry=roots.get(root);if(entry&&!entry.enabled)throw new Error('local-run-stopped');
}
export async function isolatedLaunch(cwd:string,executable:string,args:readonly string[]):
  Promise<{executable:string;args:string[]}> {
  const entry=[...roots.entries()].find(([root])=>cwd===root || cwd.startsWith(root+sep));
  if (!entry) return {executable,args:[...args]}; // legacy non-local-run callers unchanged
  const [root,authority]=entry;
  if (!authority.enabled) throw new Error('local-run-stopped');
  if (await realpath(cwd) !== cwd || relative(root,cwd).startsWith('..')) throw new Error('local-cwd-changed');
  const info=await lstat(root); if(!info.isDirectory()||info.isSymbolicLink()||info.dev!==authority.dev||info.ino!==authority.ino)throw new Error('local-root-changed');
  await snapshotCodexTree(root);
  if (!authority.enabled) throw new Error('local-run-stopped');
  return {executable:'/usr/bin/sandbox-exec',args:['-p',authority.profile,executable,...args]};
}
