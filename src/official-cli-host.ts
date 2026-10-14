import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveOfficialCodexPayload } from './codex-app-server.js';
import type { OfficialCliProbePort } from './official-cli-probe.js';
import type { OfficialCliId } from './official-cli-state.js';

type Account = Awaited<ReturnType<OfficialCliProbePort['inspectAccount']>>;
const unknownAccount: Account = {authenticated:null, subscription:null, runnableInGui:false};

export function parseManufacturerVersion(provider: OfficialCliId, output: string): string | null {
  const pattern = provider === 'codex' ? /^codex-cli (\d+\.\d+\.\d+)\s*$/
    : provider === 'claude' ? /^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/ : /^kimi, version (\d+\.\d+\.\d+)\s*$/;
  return pattern.exec(output)?.[1] ?? null;
}

export function projectClaudeAccount(output: string): Account {
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownAccount;
    const record = value as Record<string,unknown>;
    if (typeof record.loggedIn !== 'boolean') return unknownAccount;
    const subscription = record.loggedIn && record.authMethod === 'claude.ai'
      ? ['pro','max','team','enterprise'].includes(String(record.subscriptionType))
        ? true : null
      : record.loggedIn ? false : null;
    return {authenticated:record.loggedIn,subscription,runnableInGui:false};
  } catch {return unknownAccount;}
}
export function projectCodexLoginStatus(output:string):Account {
  if(output.trim()==='Logged in using ChatGPT')return {authenticated:true,subscription:null,runnableInGui:false};
  if(output.trim()==='Not logged in')return {authenticated:false,subscription:null,runnableInGui:false};
  return unknownAccount;
}

/** Only fixed argv and a minimal environment; no raw output crosses the protocol. */
function inspectCommand(executable: string, args: readonly string[], signal: AbortSignal,combined=false): Promise<string> {
  return new Promise((resolve,reject) => {
    execFile(executable,[...args],{signal,timeout:3_500,maxBuffer:16_384,
      env:{HOME:homedir(), PATH:'/usr/bin:/bin', LANG:'C', TERM:'dumb'}},
    (error,stdout,stderr) => {
      const output=combined?stdout+stderr:stdout;
      return error && (!output || signal.aborted) ? reject(new Error('manufacturer-check-failed')) : resolve(output);
    });
  });
}

async function installed(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    try {await lstat(path); return true;} catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function trustedClaude(signal: AbortSignal): Promise<string> {
  const path = await realpath(join(homedir(),'.local/bin/claude'));
  const base = join(homedir(),'.local/share/claude/versions');
  if (dirname(path) !== base) throw new Error('manufacturer-path-unverified');
  for (const entry of [path,base,dirname(base),dirname(dirname(base))]) {
    const stat = await lstat(entry);
    if (stat.isSymbolicLink() || ![0,process.getuid?.()].includes(stat.uid)
      || (stat.mode & 0o022) !== 0 || (entry === path && !stat.isFile())) {
      throw new Error('manufacturer-path-unverified');
    }
  }
  // The requirement checks both manufacturer team and application identity.
  await inspectCommand('/usr/bin/codesign',['--verify','--strict','-R',
    '=anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"',path],signal);
  return path;
}

export function createOfficialCliHostProbe(): OfficialCliProbePort {
  return {
    async inspectInstallation(provider,signal) {
      const paths = provider === 'codex' ? ['/usr/local/bin/codex','/opt/homebrew/bin/codex']
        : provider === 'claude' ? [join(homedir(),'.local/bin/claude')]
        : [join(homedir(),'.kimi-code/bin/kimi'),join(homedir(),'.local/bin/kimi')];
      const exists = await installed(paths);
      if (!exists) return {installed:false,version:null,compatible:null};
      try {
        if (provider === 'codex') {
          await resolveOfficialCodexPayload();
          if (signal.aborted) throw new Error('retired');
          return {installed:true,version:'0.159.1',compatible:true};
        }
        if (provider === 'claude') {
          const path = await trustedClaude(signal);
          const version = parseManufacturerVersion(provider,await inspectCommand(path,
            ['--safe-mode','--setting-sources','','--version'],signal));
          return {installed:true,version,compatible:version !== null};
        }
        // Python/npm Kimi distributions lack this adapter's proven executable
        // provenance. Do not execute an unverified PATH binary to guess readiness.
        return {installed:true,version:null,compatible:null};
      } catch {return {installed:true,version:null,compatible:null};}
    },
    async inspectAccount(provider,signal) {
      if (provider === 'codex') {
        const executable=await resolveOfficialCodexPayload();
        return projectCodexLoginStatus(await inspectCommand(executable.payloadRealpath,['login','status'],signal,true));
      }
      if (provider === 'claude') {
        const path = await trustedClaude(signal);
        return projectClaudeAccount(await inspectCommand(path,
          ['--safe-mode','--setting-sources','','auth','status','--json'],signal));
      }
      return unknownAccount;
    },
  };
}
