//! Shared acceptance pins plus Unix-specific real process fixtures.
use orcode_gui_lib::engine::{acquire_process_spawn_guard, resolve_node, NODE_FALLBACKS};
use orcode_gui_lib::packaged_app_trust::{
    verify_fixture_with_security_framework_port, verify_without_policy, PackagedTrustError,
    TrustFixture,
};
use std::path::PathBuf;
use std::process::Command;

#[cfg(unix)]
#[path = "engine_lifecycle/unix.rs"]
mod unix;

fn node() -> PathBuf {
    resolve_node(
        std::env::var("ORCODE_GUI_NODE").ok().as_deref(),
        None,
        std::env::var("PATH").ok().as_deref(),
        NODE_FALLBACKS,
        &|path| path.exists(),
    )
    .expect("these tests need Node; set ORCODE_GUI_NODE")
}

fn manifest_rust_version() -> String {
    let manifest =
        std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
            .expect("read Cargo.toml");
    manifest
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("rust-version = \"")
                .and_then(|v| v.strip_suffix('"'))
        })
        .expect("manifest rust-version")
        .to_string()
}

#[test]
fn task_1_declares_the_locked_graph_msrv() {
    assert_eq!(manifest_rust_version(), "1.88");
}

#[test]
fn packaged_trust_failures_stay_fixed_disabled() {
    for failure in [
        TrustFixture::Unsigned,
        TrustFixture::AdHoc,
        TrustFixture::MissingTeamIdentifier,
        TrustFixture::WrongDesignatedRequirement,
        TrustFixture::AlteredSealedResource,
        TrustFixture::AlteredNestedExecutable,
        TrustFixture::WritableMount,
        TrustFixture::NetworkMount,
        TrustFixture::FuseMount,
        TrustFixture::ArbitraryVolumesMount,
    ] {
        assert_eq!(
            verify_fixture_with_security_framework_port(failure),
            Err(PackagedTrustError::NativeLocalActionUnavailable)
        );
    }
    assert_eq!(
        verify_without_policy(),
        Err(PackagedTrustError::NativeLocalActionUnavailable)
    );
}

#[test]
fn task_1_fix_real_spawn_inventory_remains_pinned() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let scanner = r#"
const fs=require('node:fs'), path=require('node:path');
function tokens(source){
  const out=[];let i=0;
  while(i<source.length){
    const c=source[i],n=source[i+1];
    if(/\s/.test(c)){i++;continue}
    if(c==='/'&&n==='/'){i+=2;while(i<source.length&&source[i]!=='\n')i++;continue}
    if(c==='/'&&n==='*'){i+=2;while(i<source.length&&!(source[i]==='*'&&source[i+1]==='/'))i++;i=Math.min(source.length,i+2);continue}
    if(c==='/'&&(!out.length||['=','(','[','{',',',':',';','!','?','return','=>'].includes(out.at(-1).value))){
      const start=i++;let bracket=false,closed=false;
      while(i<source.length&&source[i]!=='\n'){if(source[i]==='\\'){i+=2;continue}if(source[i]==='[')bracket=true;else if(source[i]===']')bracket=false;else if(source[i]==='/'&&!bracket){i++;while(/[A-Za-z]/.test(source[i]||''))i++;closed=true;break}i++}
      if(closed){out.push({kind:'regex',value:source.slice(start,i),index:start,end:i});continue}
      i=start+1;out.push({kind:'punct',value:'/',index:start,end:i});continue
    }
    if(c==='"'||c==="'"||c==='`'){
      const start=i++,quote=c;let value='';
      while(i<source.length&&source[i]!==quote){if(source[i]==='\\'&&i+1<source.length){value+=source[i+1];i+=2}else value+=source[i++]}
      if(i>=source.length)throw new Error('unterminated string in '+source.slice(start,start+40));
      i++;out.push({kind:'string',value,index:start,end:i});continue
    }
    if(/[A-Za-z_$]/.test(c)){const start=i++;while(i<source.length&&/[\w$]/.test(source[i]))i++;out.push({kind:'id',value:source.slice(start,i),index:start,end:i});continue}
    out.push({kind:'punct',value:c,index:i,end:i+1});i++
  }
  return out
}
function inventory(file,source){
  const ts=tokens(source),aliases=new Map,namespaces=new Set,namespaceBindings=new Set,isModule=t=>t&&t.kind==='string'&&(t.value==='child_process'||t.value==='node:child_process');
  function named(parts,separator){for(let i=1;i<parts.length-1;){if(parts[i].value===','){i++;continue}if(parts[i].value==='type')i++;const api=parts[i]?.value;i++;let local=api;if(parts[i]?.value===separator){local=parts[i+1]?.value;i+=2}if((api==='spawn'||api==='execFile')&&local)aliases.set(local,api);while(i<parts.length-1&&parts[i].value!==',')i++}}
  for(let i=0;i<ts.length;i++){
    if(ts[i].value==='import'){
      if(ts[i+1]?.value==='('){if(isModule(ts[i+2]))throw new Error('unsupported dynamic child_process import in '+file);continue}
      if(isModule(ts[i+1]))throw new Error('unsupported side-effect child_process import in '+file);
      let from=i+1;while(from<ts.length&&ts[from].value!==';'&&ts[from].value!=='from')from++;
      if(ts[from]?.value!=='from'||!isModule(ts[from+1]))continue;
      const binding=ts.slice(i+1,from);
      if(binding[0]?.value==='{'&&binding.at(-1)?.value==='}')named(binding,'as');
      else if(binding[0]?.value==='*'&&binding[1]?.value==='as'&&binding[2]?.kind==='id'&&binding.length===3){namespaces.add(binding[2].value);namespaceBindings.add(i+3)}
      else throw new Error('unsupported child_process import binding in '+file);
      i=from+1;continue
    }
    if(ts[i].value==='require'&&ts[i+1]?.value==='('&&isModule(ts[i+2])&&ts[i+3]?.value===')'){
      if(ts[i+4]?.value==='.'||ts[i+4]?.value==='[')throw new Error('unsupported child_process require member binding in '+file);
      if(ts[i-1]?.value!=='=')throw new Error('unsupported child_process require use in '+file);
      let declaration=i-2;while(declaration>=0&&!['const','let','var',';'].includes(ts[declaration].value))declaration--;
      if(!['const','let','var'].includes(ts[declaration]?.value))throw new Error('unsupported child_process require binding in '+file);
      const binding=ts.slice(declaration+1,i-1);
      if(binding.length===1&&binding[0].kind==='id'){namespaces.add(binding[0].value);namespaceBindings.add(declaration+1)}
      else if(binding[0]?.value==='{'&&binding.at(-1)?.value==='}')named(binding,':');
      else throw new Error('unsupported child_process require binding in '+file);
      i+=3
    }
  }
  let changed=true;while(changed){changed=false;for(let i=0;i+3<ts.length;i++){if(!['const','let','var'].includes(ts[i].value)||ts[i+1].kind!=='id'||ts[i+2].value!=='='||aliases.has(ts[i+1].value))continue;let end=i+3;while(end<ts.length&&ts[end].value!==';')end++;for(let j=i+3;j<end;j++){if(ts[j].kind==='id'&&aliases.has(ts[j].value)&&ts[j+1]?.value!=='('){aliases.set(ts[i+1].value,aliases.get(ts[j].value));changed=true;break}}}}
  const out=[];
  function record(api,start,open){let depth=0,close=open;for(;close<ts.length;close++){if(ts[close].value==='(')depth++;else if(ts[close].value===')'&&--depth===0)break}const call=source.slice(ts[start].index,ts[close]?.end||ts[open].end),stdioMatch=/\bstdio\s*:\s*(\[[^\]]*\]|["'][^"']*["'])/.exec(call);let stdio='default';if(stdioMatch){if(stdioMatch[1][0]==='[')stdio='['+[...stdioMatch[1].matchAll(/["']([^"']*)["']/g)].map(x=>x[1]).join(',')+']';else stdio=stdioMatch[1].slice(1,-1)}out.push({file,api,stdio,line:source.slice(0,ts[start].index).split('\n').length})}
  for(let i=0;i<ts.length;i++){
    if(ts[i].kind==='id'&&aliases.has(ts[i].value)&&ts[i+1]?.value==='(')record(aliases.get(ts[i].value),i,i+1);
    if(ts[i].kind==='id'&&namespaces.has(ts[i].value)){
      if(namespaceBindings.has(i))continue;
      if(ts[i+1]?.value==='.'&&(ts[i+2]?.value==='spawn'||ts[i+2]?.value==='execFile')&&ts[i+3]?.value==='(')record(ts[i+2].value,i,i+3);
      else throw new Error('unsupported child_process namespace access in '+file)
    }
  }
  return out
}
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):e.name.endsWith('.ts')?[path.join(dir,e.name)]:[])}
const root=process.argv[1], src=path.join(root,'src'); let real=files(src).flatMap(f=>{const source=fs.readFileSync(f,'utf8');return source.includes('child_process')?inventory(path.relative(root,f),source):[]}); real.sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line);
const synthetic='import { spawn as namedSpawn } from "node:child_process";\nimport * as cp from "child_process";\nconst required=require("child_process");\nconst {spawn: requiredSpawn}=require("node:child_process");\n// cp.spawn("comment")\nconst text="required.spawn(\\\"string\\\")";\n/* requiredSpawn("block") */\nnamedSpawn("0",[],{stdio:"ignore"});\ncp.spawn("1",[],{stdio:"ignore"});\nrequired.spawn("2",[],{stdio:"ignore"});\nrequiredSpawn("3",[],{stdio:"ignore"});\nnamedSpawn("4",[],{stdio:"ignore"});\ncp.spawn("5",[],{stdio:"ignore"});';
let rejectedUnknown=false;try{inventory('unknown.ts','import childProcess from "node:child_process";\nchildProcess.spawn("x");')}catch{rejectedUnknown=true}
let rejectedMember=false;try{inventory('member.ts','const spawn=require("node:child_process").spawn;\nspawn("x");')}catch{rejectedMember=true}
process.stdout.write(JSON.stringify({real,synthetic:inventory('synthetic.ts',synthetic),rejectedUnknown,rejectedMember}));
"#;
    let guard = acquire_process_spawn_guard();
    let output = Command::new(node())
        .arg("-e")
        .arg(scanner)
        .arg(&root)
        .output()
        .expect("run dependency-free TypeScript spawn scanner");
    drop(guard);
    assert!(
        output.status.success(),
        "scanner failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).expect("scanner JSON");
    assert_eq!(report["synthetic"].as_array().map(Vec::len), Some(6));
    assert_eq!(report["rejectedUnknown"].as_bool(), Some(true));
    assert_eq!(report["rejectedMember"].as_bool(), Some(true));
    let actual: Vec<_> = report["real"]
        .as_array()
        .expect("real inventory")
        .iter()
        .map(|site| {
            (
                site["file"].as_str().unwrap(),
                site["api"].as_str().unwrap(),
                site["stdio"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        actual,
        [
            ("src/browser-engine.ts", "spawn", "ignore"),
            ("src/cli.ts", "execFile", "default"),
            ("src/codex-app-server.ts", "spawn", "[pipe,pipe,pipe]"),
            ("src/codex-app-server.ts", "execFile", "default"),
            // Reviewed: runDarwinDf invokes fixed /bin/df with a closed argv,
            // closed env/maxBuffer, and no shell or private-channel handles.
            ("src/codex-profile.ts", "execFile", "default"),
            // Darwin xattr inspection: fixed /usr/bin/xattr, bounded output,
            // explicit ignore/pipe/ignore stdio; no shell or private descriptors.
            (
                "src/codex-staging-workspace.ts",
                "spawn",
                "[ignore,pipe,ignore]"
            ),
            // Manufacturer status: verified executable, closed argv/minimal env,
            // timeout and maxBuffer; raw output never enters the GUI protocol.
            ("src/official-cli-host.ts", "execFile", "default"),
            ("src/private-store.ts", "spawn", "[ignore,pipe,pipe]"),
            ("src/voice.ts", "spawn", "[ignore,ignore,pipe]"),
            ("src/workspace.ts", "spawn", "[ignore,pipe,pipe]"),
            // Workspace xattr inspection and the existing tool launcher have
            // separate reviewed calls with explicit three-descriptor stdio.
            ("src/workspace.ts", "spawn", "[ignore,pipe,pipe]"),
        ],
        "the exact node:child_process spawn inventory drifted"
    );
}
