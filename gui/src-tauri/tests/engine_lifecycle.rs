//! What actually happens to a real child process — measured, not assumed.
//!
//! Two of G0's open questions are answered here rather than argued:
//!
//!  * **Does closing stdin end the engine?** It is the protocol's third
//!    shutdown trigger and the only reliable macOS parent-death signal, and
//!    the whole shutdown path rests on it. So it is measured against a real
//!    node child.
//!  * **What signal does the kill fallback send?** These tests drive
//!    `std::process::Child::kill` and read the termination signal back off the
//!    wait status.
//!
//! No window, no WebView, no Tauri app — just the process primitives the
//! shell's shutdown is built on.

use std::io::{Cursor, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use orcode_gui_lib::engine::{
    acquire_process_spawn_guard, create_native_sidecar_channels, probe_fixed_fd_collision_matrix,
    read_private_frame, resolve_node, spawn_raw_engine, spawn_raw_engine_after,
    try_acquire_process_spawn_guard, ChildPipe, ControlPipeError, ControlPipeWriter,
    ForceKillResult, GenerationDrain, LifecyclePhase, LifecycleStore, NativeActionReader,
    RawEngine, RawEngineEvent, RawProcessOwnership, StderrTail, ACTION_FRAME_TAG,
    CONTROL_FRAME_TAG, MAX_PRIVATE_PAYLOAD, NODE_FALLBACKS, RAW_EVENT_CAPACITY,
};
use orcode_gui_lib::packaged_app_trust::{
    verify_fixture_with_security_framework_port, verify_without_policy, PackagedTrustError,
    TrustFixture,
};

fn node() -> PathBuf {
    resolve_node(
        std::env::var("ORCODE_GUI_NODE").ok().as_deref(),
        // No bundled runtime in a cargo test: this is the dev shape.
        None,
        std::env::var("PATH").ok().as_deref(),
        NODE_FALLBACKS,
        &|path| path.exists(),
    )
    .expect("these tests need a node binary; set ORCODE_GUI_NODE")
}

fn wait_for_exit(
    child: &mut std::process::Child,
    bound: Duration,
) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + bound;
    while Instant::now() < deadline {
        match child.try_wait().expect("try_wait") {
            Some(status) => return Some(status),
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    None
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/private-channel-child.mjs")
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

fn private_frame(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(tag);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

fn write_fd(fd: i32, bytes: &[u8]) {
    let mut remaining = bytes;
    while !remaining.is_empty() {
        // SAFETY: `fd` is a live pipe end owned by the test's channel bundle.
        let wrote = unsafe { libc::write(fd, remaining.as_ptr().cast(), remaining.len()) };
        assert!(
            wrote > 0,
            "write private test frame: {}",
            std::io::Error::last_os_error()
        );
        remaining = &remaining[wrote as usize..];
    }
}

fn occupy_through_fd(last: i32) -> Vec<OwnedFd> {
    let path = std::ffi::CString::new("/dev/null").unwrap();
    let mut held = Vec::new();
    loop {
        // SAFETY: `path` is NUL terminated and a successful descriptor is
        // immediately assigned exactly one OwnedFd owner.
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
        assert!(
            fd >= 0,
            "open /dev/null: {}",
            std::io::Error::last_os_error()
        );
        // SAFETY: `open` returned a new descriptor and ownership transfers once.
        held.push(unsafe { OwnedFd::from_raw_fd(fd) });
        if fd == last {
            return held;
        }
        assert!(
            fd < last,
            "fd {last} was already occupied before exact-target probe"
        );
    }
}

fn spawn_control_echo(
    guard: &orcode_gui_lib::engine::ProcessSpawnGuard,
) -> (RawEngine, NativeActionReader, ControlPipeWriter) {
    let script = r#"
const fs = require('node:fs');
function exact(fd, n) { const b=Buffer.alloc(n); let o=0; while(o<n) o += fs.readSync(fd,b,o,n-o,null); return b; }
const h=exact(199,5); const n=h.readUInt32BE(1); const p=exact(199,n);
const out=Buffer.alloc(5); out[0]=0xa1; out.writeUInt32BE(p.length,1); fs.writeSync(198,out); fs.writeSync(198,p);
"#;
    let mut channels = create_native_sidecar_channels(guard).expect("control echo channels");
    let mut command = Command::new(node());
    command.arg("-e").arg(script);
    channels
        .prepare_command(&mut command)
        .expect("prepare control echo");
    let raw = spawn_raw_engine_after(guard, command, || channels.parent_after_spawn())
        .expect("spawn control echo");
    let (action, control) = channels.into_parent_ends().expect("control echo ends");
    (raw, action, control)
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
fn task_1_fix_collision_exact_target_child() {
    if std::env::var_os("ORCODE_EXACT_TARGET_CHILD").is_none() {
        return;
    }
    let guard = acquire_process_spawn_guard();
    let held = occupy_through_fd(197);
    let probes = probe_fixed_fd_collision_matrix(&guard).expect("exact-target collision matrix");
    assert!(probes.iter().all(|probe| probe.safe), "{probes:?}");

    let mut channels = create_native_sidecar_channels(&guard).expect("exact-target channels");
    assert_eq!(channels.child_action_write_fd, 199);
    assert_eq!(channels.child_control_read_fd, 200);
    let mut command = Command::new(node());
    command
        .arg(fixture())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    channels
        .prepare_command(&mut command)
        .expect("prepare exact targets");
    let raw = spawn_raw_engine_after(&guard, command, || channels.parent_after_spawn())
        .expect("spawn exact-target fixture");
    drop(held);
    drop(guard);
    channels
        .control_writer
        .write_frame(b"exact-target")
        .unwrap();
    assert_eq!(
        channels.action_reader.read_frame().unwrap(),
        b"exact-target"
    );
    raw.revoke_and_join(Duration::from_secs(3)).unwrap();
}

#[test]
fn task_1_fix_collision_exact_target_has_single_fd_ownership() {
    let guard = acquire_process_spawn_guard();
    let status = Command::new(std::env::current_exe().expect("current test binary"))
        .args([
            "--exact",
            "task_1_fix_collision_exact_target_child",
            "--nocapture",
        ])
        .env("ORCODE_EXACT_TARGET_CHILD", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run exact-target collision subprocess");
    drop(guard);
    assert!(status.success(), "exact-target probe aborted: {status:?}");
}

#[test]
fn task_1_fix_private_action_reader_fails_closed_after_invalid_frame() {
    let guard = acquire_process_spawn_guard();
    let mut channels = create_native_sidecar_channels(&guard).expect("channels");
    let writer_fd = channels.child_action_write_fd;
    write_fd(writer_fd, &private_frame(CONTROL_FRAME_TAG, b""));
    write_fd(
        writer_fd,
        &private_frame(ACTION_FRAME_TAG, b"must-not-pass"),
    );
    assert!(channels.action_reader.read_frame().is_err());
    assert!(
        channels.action_reader.read_frame().is_err(),
        "a valid permit following an invalid frame was accepted"
    );
    channels.parent_after_spawn();
}

#[test]
fn task_1_fix_revocation_interrupts_inherited_stdout_and_stderr() {
    let guard = acquire_process_spawn_guard();
    let mut command = Command::new(node());
    command.arg("-e").arg(
        "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',\"setTimeout(()=>process.exit(0),2000)\"],{detached:true,stdio:['ignore',process.stdout,process.stderr]}); c.unref();",
    );
    let raw = spawn_raw_engine(&guard, command).expect("spawn inherited-pipe fixture");
    drop(guard);
    std::thread::sleep(Duration::from_millis(150));
    let began = Instant::now();
    raw.revoke_and_join(Duration::from_millis(700))
        .expect("cancellation must interrupt inherited-pipe reads");
    assert!(began.elapsed() < Duration::from_millis(700));
}

#[test]
fn task_1_fix_natural_exit_terminates_before_inherited_descendant_closes_pipes() {
    static NEXT_MARKER: AtomicUsize = AtomicUsize::new(0);
    let marker = std::env::temp_dir().join(format!(
        "orcode-descendant-{}-{}",
        std::process::id(),
        NEXT_MARKER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_file(&marker);
    let guard = acquire_process_spawn_guard();
    let mut command = Command::new(node());
    command
        .arg("-e")
        .arg("const fs=require('node:fs'); const {spawn}=require('node:child_process'); const marker=process.env.ORCODE_DESC_MARKER; const code=\"const fs=require('node:fs'),m=process.env.ORCODE_DESC_MARKER; fs.writeFileSync(m,'alive'); const w=setInterval(()=>{try{fs.writeSync(2,Buffer.alloc(1024,0x64))}catch{}},1); setTimeout(()=>{clearInterval(w);fs.writeFileSync(m,'done');process.exit(0)},2500)\"; const c=spawn(process.execPath,['-e',code],{detached:true,stdio:['ignore',process.stdout,process.stderr]}); c.unref(); const wait=new Int32Array(new SharedArrayBuffer(4)),deadline=Date.now()+500; while(!fs.existsSync(marker)&&Date.now()<deadline)Atomics.wait(wait,0,0,2); if(!fs.existsSync(marker))throw new Error('descendant did not start'); fs.writeSync(1,`descendant=${c.pid}\\nparent-output\\n`); process.exit(0);")
        .env("ORCODE_DESC_MARKER", &marker);
    let mut raw = spawn_raw_engine(&guard, command).expect("spawn natural-exit fixture");
    let parent_pid = raw.pid() as i32;
    drop(guard);

    let began = Instant::now();
    let deadline = began + Duration::from_millis(900);
    let mut stdout = Vec::new();
    let mut terminal_at = None;
    while Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now());
        match raw.recv_event_timeout(left) {
            Ok(RawEngineEvent::Stdout(bytes)) => stdout.extend(bytes),
            Ok(RawEngineEvent::Stderr(_)) => {}
            Ok(RawEngineEvent::Error) => panic!("natural-exit output pipe failed"),
            Ok(RawEngineEvent::Terminated { code, signal }) => {
                assert_eq!((code, signal), (Some(0), None));
                terminal_at = Some(began.elapsed());
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let stdout = String::from_utf8(stdout).expect("fixture stdout");
    let descendant_pid = stdout
        .lines()
        .find_map(|line| line.strip_prefix("descendant="))
        .and_then(|pid| pid.parse::<i32>().ok())
        .expect("fixture reported descendant PID");
    assert_ne!(
        descendant_pid, parent_pid,
        "fixture did not spawn a descendant"
    );
    let descendant_was_alive_at_bound =
        std::fs::read_to_string(&marker).ok().as_deref() == Some("alive");

    // Identity-safe, bounded self-cleanup: the unique marker belongs to this
    // exact descendant. No raw PID is signalled after a wait/reuse window.
    let cleanup_deadline = Instant::now() + Duration::from_secs(3);
    while std::fs::read_to_string(&marker).ok().as_deref() != Some("done")
        && Instant::now() < cleanup_deadline
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    let descendant_self_cleaned = std::fs::read_to_string(&marker).ok().as_deref() == Some("done");
    let _ = std::fs::remove_file(&marker);

    assert!(
        descendant_was_alive_at_bound,
        "fixture descendant did not hold the inherited pipes beyond the bound"
    );
    assert!(
        descendant_self_cleaned,
        "fixture descendant did not self-clean"
    );
    assert!(
        terminal_at.is_some_and(|elapsed| elapsed < Duration::from_millis(900)),
        "natural parent exit did not publish Terminated inside 900 ms: {terminal_at:?}"
    );
    assert!(
        stdout.contains("parent-output"),
        "parent output was not drained"
    );
}

#[test]
fn task_1_fix_reap_snapshot_preserves_slow_consumer_parent_bursts() {
    const STREAM_BYTES: usize = 131_072;
    let guard = acquire_process_spawn_guard();
    let mut command = Command::new(node());
    command.arg("-e").arg(format!(
        "const fs=require('node:fs'); function writeAll(fd,byte){{const buffer=Buffer.alloc({STREAM_BYTES},byte);let offset=0;while(offset<buffer.length){{const written=fs.writeSync(fd,buffer,offset,buffer.length-offset);if(written<=0)throw new Error('short write');offset+=written}}}} writeAll(1,0x6f); writeAll(2,0x65); process.exit(0);"
    ));
    let mut raw = spawn_raw_engine(&guard, command).expect("spawn burst parent");
    drop(guard);

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        match raw
            .recv_event_timeout(Duration::from_secs(10))
            .expect("burst event")
        {
            RawEngineEvent::Stdout(bytes) => stdout.extend(bytes),
            RawEngineEvent::Stderr(bytes) => stderr.extend(bytes),
            RawEngineEvent::Error => panic!("burst output reader failed"),
            RawEngineEvent::Terminated { code, signal } => {
                assert_eq!((code, signal), (Some(0), None));
                break;
            }
        }
        // Deliberately slower than the removed 250 ms reader cutoff while
        // retaining the real capacity-one channel backpressure.
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(stdout.len(), STREAM_BYTES, "parent stdout was truncated");
    assert_eq!(stderr.len(), STREAM_BYTES, "parent stderr was truncated");
    assert!(stdout.iter().all(|byte| *byte == b'o'));
    assert!(stderr.iter().all(|byte| *byte == b'e'));
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
            ("src/private-store.ts", "spawn", "[ignore,pipe,pipe]"),
            ("src/voice.ts", "spawn", "[ignore,ignore,pipe]"),
            ("src/workspace.ts", "spawn", "[ignore,pipe,pipe]"),
        ],
        "the exact node:child_process spawn inventory drifted"
    );
}

#[test]
fn task_1_fix_natural_termination_revokes_actual_private_generation() {
    struct LifecycleOwned {
        pid: u32,
        _pipe: ChildPipe,
        _ownership: RawProcessOwnership,
        _drain: GenerationDrain,
        _action_reader: NativeActionReader,
    }

    let guard = acquire_process_spawn_guard();
    let mut channels = create_native_sidecar_channels(&guard).expect("channels");
    let action_probe_fd =
        unsafe { libc::fcntl(channels.child_action_write_fd, libc::F_DUPFD_CLOEXEC, 200) };
    let control_probe_fd =
        unsafe { libc::fcntl(channels.child_control_read_fd, libc::F_DUPFD_CLOEXEC, 200) };
    assert!(action_probe_fd >= 0 && control_probe_fd >= 0);
    // SAFETY: each successful fcntl returned a new descriptor with one owner.
    let action_probe = unsafe { OwnedFd::from_raw_fd(action_probe_fd) };
    let control_probe = unsafe { OwnedFd::from_raw_fd(control_probe_fd) };
    let mut command = Command::new(node());
    command
        .arg("-e")
        .arg("setTimeout(() => process.exit(0), 80)");
    channels
        .prepare_command(&mut command)
        .expect("prepare channels");
    let raw = spawn_raw_engine_after(&guard, command, || channels.parent_after_spawn())
        .expect("spawn short child");
    let pid = raw.pid();
    let (action_reader, control_writer) = channels.into_parent_ends().expect("parent ends");
    let (pipe, receiver, ownership, drain) = raw.into_parts();
    let store = LifecycleStore::<LifecycleOwned, Vec<RawEngineEvent>, _>::new();
    let generation = store.begin_start(&guard);
    store
        .install_live(
            &guard,
            generation,
            LifecycleOwned {
                pid,
                _pipe: pipe,
                _ownership: ownership,
                _drain: drain.clone(),
                _action_reader: action_reader,
            },
            Vec::new(),
            control_writer,
        )
        .unwrap();
    drop(guard);

    let terminal = loop {
        let event = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("event");
        if matches!(event, RawEngineEvent::Terminated { .. }) {
            break event;
        }
    };
    let removed = store.terminate_current(generation, |events| events.push(terminal));
    assert_eq!(removed.as_ref().map(|live| live.pid), Some(pid));
    drop(removed);
    receiver.acknowledge_terminated();
    assert!(drain.wait(Duration::from_secs(1)));
    assert_eq!(store.phase(), LifecyclePhase::Empty);
    assert_ne!(store.generation(), generation);
    assert!(!store.with_current_control(generation, |writer| {
        let _ = writer.write_frame(b"late-private-callback");
    }));

    let byte = [1u8];
    // SAFETY: probe owns the writer and the lifecycle-owned reader was just dropped.
    let wrote = unsafe { libc::write(action_probe.as_raw_fd(), byte.as_ptr().cast(), 1) };
    assert_eq!(wrote, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EPIPE)
    );
    let flags = unsafe { libc::fcntl(control_probe.as_raw_fd(), libc::F_GETFL) };
    unsafe {
        libc::fcntl(
            control_probe.as_raw_fd(),
            libc::F_SETFL,
            flags | libc::O_NONBLOCK,
        )
    };
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let mut byte = [0u8];
        let read = unsafe { libc::read(control_probe.as_raw_fd(), byte.as_mut_ptr().cast(), 1) };
        if read == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "control writer did not revoke");
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn task_1_fix_generation_drain_waits_for_consumer_acknowledgement() {
    let guard = acquire_process_spawn_guard();
    let mut command = Command::new(node());
    command
        .arg("-e")
        .arg("process.stderr.write('old-generation-stderr');");
    let raw = spawn_raw_engine(&guard, command).expect("spawn old generation");
    drop(guard);
    let (_pipe, receiver, _ownership, drain) = raw.into_parts();
    loop {
        let event = receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("event");
        if matches!(event, RawEngineEvent::Terminated { .. }) {
            break;
        }
    }
    assert!(
        !drain.wait(Duration::from_millis(50)),
        "producer enqueue was incorrectly treated as final consumer handling"
    );
    receiver.acknowledge_terminated();
    assert!(drain.wait(Duration::from_secs(1)));
}

#[test]
fn task_1_fix_old_stderr_cannot_classify_successor_generation() {
    let guard = acquire_process_spawn_guard();
    let mut command = Command::new(node());
    command.arg("-e").arg(
        "setTimeout(() => { process.stderr.write('Error: old-only\\n    at old (old.js:1:1)'); }, 80)",
    );
    let mut old = spawn_raw_engine(&guard, command).expect("spawn old generation");
    let old_pid = old.pid();
    let store = Arc::new(LifecycleStore::<
        u32,
        std::sync::mpsc::SyncSender<Option<String>>,
        Vec<u8>,
    >::new());
    let (old_public, old_public_receiver) = std::sync::mpsc::sync_channel(1);
    let old_generation = store.begin_start(&guard);
    store
        .install_live(&guard, old_generation, old_pid, old_public, Vec::new())
        .unwrap();
    drop(guard);
    let mut old_tail = StderrTail::default();
    loop {
        match old
            .recv_event_timeout(Duration::from_secs(3))
            .expect("event")
        {
            RawEngineEvent::Stderr(bytes) => old_tail.push(&String::from_utf8_lossy(&bytes)),
            RawEngineEvent::Terminated { .. } => break,
            _ => {}
        }
    }
    let old_cause = old_tail.classify().map(str::to_string);
    assert_eq!(old_cause.as_deref(), Some("engine-crashed"));
    old.revoke_and_join(Duration::from_secs(1)).unwrap();

    let guard = acquire_process_spawn_guard();
    let mut successor_command = Command::new(node());
    successor_command
        .arg("-e")
        .arg("setTimeout(() => process.exit(0), 40)");
    let successor = spawn_raw_engine(&guard, successor_command).unwrap();
    let successor_pid = successor.pid();
    drop(guard);
    let (successor_public, successor_receiver) = std::sync::mpsc::sync_channel(1);
    let release_old = Arc::new(Barrier::new(2));
    let publish_store = Arc::clone(&store);
    let publish_release = Arc::clone(&release_old);
    let publisher = std::thread::spawn(move || {
        publish_release.wait();
        publish_store.with_current_public(old_generation, |channel| {
            channel.try_send(old_cause).unwrap();
        })
    });
    let guard = acquire_process_spawn_guard();
    let successor_generation = store.begin_start(&guard);
    store
        .install_live(
            &guard,
            successor_generation,
            successor_pid,
            successor_public,
            Vec::new(),
        )
        .unwrap();
    drop(guard);
    release_old.wait();
    assert!(!publisher.join().unwrap());
    assert!(old_public_receiver.try_recv().is_err());
    assert!(store.with_current_public(successor_generation, |channel| {
        channel.try_send(None).unwrap();
    }));
    assert_eq!(
        successor_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        None
    );
    successor.revoke_and_join(Duration::from_secs(1)).unwrap();
}

#[test]
fn task_1_fix_owner_wait_has_no_runtime_snapshot_and_reaps_before_successor() {
    let guard = acquire_process_spawn_guard();
    let mut command = Command::new(node());
    command
        .arg("-e")
        .arg("process.stdin.resume(); setInterval(() => {}, 1000)");
    let raw = spawn_raw_engine(&guard, command).expect("spawn stubborn old child");
    let old_pid = raw.pid();
    drop(guard);
    let (_pipe, receiver, ownership, drain) = raw.into_parts();
    assert_eq!(
        ownership.force_kill(Duration::from_secs(1)).unwrap(),
        ForceKillResult::Signalled
    );
    assert!(ownership.wait_reaped(Duration::from_secs(1)));
    assert!(!ownership.is_alive(), "old Child was not reaped");
    receiver.revoke();
    drop(receiver);
    assert!(drain.wait(Duration::from_secs(1)));

    let guard = acquire_process_spawn_guard();
    let mut successor = Command::new(node());
    successor.arg("-e").arg("setTimeout(() => {}, 20)");
    let successor = spawn_raw_engine(&guard, successor).expect("spawn successor after reap");
    assert_ne!(successor.pid(), old_pid);
    drop(guard);
    successor.revoke_and_join(Duration::from_secs(1)).unwrap();
}

#[test]
fn task_1_fix_actual_control_pipes_obey_both_generation_race_orderings() {
    let guard = acquire_process_spawn_guard();
    let (old_raw, mut old_action, old_control) = spawn_control_echo(&guard);
    let (new_raw, mut new_action, new_control) = spawn_control_echo(&guard);
    let old_pid = old_raw.pid();
    let new_pid = new_raw.pid();
    let store = Arc::new(LifecycleStore::<u32, Vec<Vec<u8>>, ControlPipeWriter>::new());
    let old_generation = store.begin_start(&guard);
    store
        .install_live(&guard, old_generation, old_pid, Vec::new(), old_control)
        .unwrap();
    drop(guard);

    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let callback_store = Arc::clone(&store);
    let callback_entered = Arc::clone(&entered);
    let callback_release = Arc::clone(&release);
    let callback = std::thread::spawn(move || {
        callback_store.with_current_control(old_generation, |writer| {
            callback_entered.wait();
            callback_release.wait();
            writer.write_frame(b"old-wins").unwrap();
        })
    });
    entered.wait();
    let restart_store = Arc::clone(&store);
    let restart = std::thread::spawn(move || {
        let guard = acquire_process_spawn_guard();
        let generation = restart_store.begin_start(&guard);
        restart_store
            .install_live(&guard, generation, new_pid, Vec::new(), new_control)
            .unwrap();
        generation
    });
    release.wait();
    assert!(
        callback.join().unwrap(),
        "callback-first ordering was revoked early"
    );
    let new_generation = restart.join().unwrap();
    assert!(!store.with_current_control(old_generation, |writer| {
        let _ = writer.write_frame(b"late-old");
    }));
    assert!(store.with_current_control(new_generation, |writer| {
        writer.write_frame(b"new-wins").unwrap();
    }));
    assert_eq!(old_action.read_frame().unwrap(), b"old-wins");
    assert_eq!(new_action.read_frame().unwrap(), b"new-wins");
    old_raw.revoke_and_join(Duration::from_secs(2)).unwrap();
    new_raw.revoke_and_join(Duration::from_secs(2)).unwrap();
}

#[test]
fn task_1_fix_control_ack_wait_does_not_hold_lifecycle_lock() {
    let guard = acquire_process_spawn_guard();
    let mut channels = create_native_sidecar_channels(&guard).expect("stalled control channels");
    let mut command = Command::new(node());
    command
        .arg("-e")
        .arg("setTimeout(() => process.exit(0), 2500)");
    channels
        .prepare_command(&mut command)
        .expect("prepare stalled control child");
    let raw = spawn_raw_engine_after(&guard, command, || channels.parent_after_spawn())
        .expect("spawn stalled control child");
    let pid = raw.pid();
    let (_action_reader, mut control_writer) =
        channels.into_parent_ends().expect("stalled parent ends");

    let payload = vec![b'x'; MAX_PRIVATE_PAYLOAD];
    let mut saturated = false;
    for _ in 0..64 {
        match control_writer.write_frame(&payload) {
            Ok(()) => {}
            Err(ControlPipeError::Stalled) => {
                saturated = true;
                break;
            }
            Err(error) => panic!("unexpected saturation result: {error:?}"),
        }
    }
    assert!(saturated, "fixture did not fill the unread control pipe");

    let store = Arc::new(LifecycleStore::<u32, Vec<Vec<u8>>, ControlPipeWriter>::new());
    let generation = store.begin_start(&guard);
    store
        .install_live(&guard, generation, pid, Vec::new(), control_writer)
        .unwrap();
    drop(guard);

    let receipt = store
        .enqueue_current_control(generation, b"dialog-result")
        .expect("enqueue remains nonblocking");
    let waiting = Arc::new(Barrier::new(2));
    let waiter_ready = Arc::clone(&waiting);
    let waiter = std::thread::spawn(move || {
        waiter_ready.wait();
        receipt.wait()
    });
    waiting.wait();
    let began = Instant::now();
    store.with_live(|live, phase| {
        assert_eq!(phase, LifecyclePhase::Live);
        assert_eq!(live.copied(), Some(pid));
    });
    assert!(
        began.elapsed() < Duration::from_millis(100),
        "control acknowledgement held the lifecycle lock"
    );
    assert_eq!(waiter.join().unwrap(), Err(ControlPipeError::Stalled));
    raw.revoke_and_join(Duration::from_secs(2)).unwrap();
}

#[test]
fn task_1_fix_actual_raw_pids_serialize_start_start_and_start_stop_reap() {
    fn replacement(
        store: Arc<LifecycleStore<RawEngine, Vec<u32>, Vec<u8>>>,
        ready: Arc<Barrier>,
    ) -> (Option<u32>, u32) {
        ready.wait();
        let guard = acquire_process_spawn_guard();
        let previous = store.take_live_for_stop(&guard).map(|raw| {
            let pid = raw.pid();
            raw.revoke_and_join(Duration::from_secs(2)).unwrap();
            pid
        });
        store.finish_stop(&guard);
        let mut command = Command::new(node());
        command.arg("-e").arg("setInterval(() => {}, 1000)");
        let raw = spawn_raw_engine(&guard, command).unwrap();
        let pid = raw.pid();
        let generation = store.begin_start(&guard);
        store
            .install_live(&guard, generation, raw, Vec::new(), Vec::new())
            .unwrap();
        (previous, pid)
    }

    let store = Arc::new(LifecycleStore::<RawEngine, Vec<u32>, Vec<u8>>::new());
    let guard = acquire_process_spawn_guard();
    let mut initial_command = Command::new(node());
    initial_command.arg("-e").arg("setInterval(() => {}, 1000)");
    let initial = spawn_raw_engine(&guard, initial_command).unwrap();
    let initial_pid = initial.pid();
    let generation = store.begin_start(&guard);
    store
        .install_live(&guard, generation, initial, Vec::new(), Vec::new())
        .unwrap();
    drop(guard);

    let ready = Arc::new(Barrier::new(3));
    let first = {
        let store = Arc::clone(&store);
        let ready = Arc::clone(&ready);
        std::thread::spawn(move || replacement(store, ready))
    };
    let second = {
        let store = Arc::clone(&store);
        let ready = Arc::clone(&ready);
        std::thread::spawn(move || replacement(store, ready))
    };
    ready.wait();
    let first = first.join().unwrap();
    let second = second.join().unwrap();
    let spawned = [first.1, second.1];
    assert_ne!(spawned[0], spawned[1]);
    assert!(
        first.0 == Some(initial_pid) || second.0 == Some(initial_pid),
        "the initial Child was not owned and reaped by the first replacement"
    );
    assert!(first.0 == Some(second.1) || second.0 == Some(first.1));

    let guard = acquire_process_spawn_guard();
    let final_raw = store.take_live_for_stop(&guard).expect("final live child");
    let final_pid = final_raw.pid();
    final_raw.revoke_and_join(Duration::from_secs(2)).unwrap();
    store.finish_stop(&guard);
    drop(guard);
    assert!(spawned.contains(&final_pid));
    assert_eq!(store.phase(), LifecyclePhase::Empty);

    let install_gap = Arc::new(Barrier::new(2));
    let permit_install = Arc::new(Barrier::new(2));
    let starter = {
        let store = Arc::clone(&store);
        let install_gap = Arc::clone(&install_gap);
        let permit_install = Arc::clone(&permit_install);
        std::thread::spawn(move || {
            let guard = acquire_process_spawn_guard();
            let generation = store.begin_start(&guard);
            let mut command = Command::new(node());
            command.arg("-e").arg("setInterval(() => {}, 1000)");
            let raw = spawn_raw_engine(&guard, command).unwrap();
            let pid = raw.pid();
            install_gap.wait();
            permit_install.wait();
            store
                .install_live(&guard, generation, raw, Vec::new(), Vec::new())
                .unwrap();
            pid
        })
    };
    install_gap.wait();
    assert_eq!(store.phase(), LifecyclePhase::Starting);
    let stop_attempted = Arc::new(Barrier::new(2));
    let stopper = {
        let store = Arc::clone(&store);
        let stop_attempted = Arc::clone(&stop_attempted);
        std::thread::spawn(move || {
            stop_attempted.wait();
            let guard = acquire_process_spawn_guard();
            let raw = store
                .take_live_for_stop(&guard)
                .expect("stop saw installed child");
            let pid = raw.pid();
            raw.revoke_and_join(Duration::from_secs(2)).unwrap();
            store.finish_stop(&guard);
            pid
        })
    };
    stop_attempted.wait();
    permit_install.wait();
    let started_pid = starter.join().unwrap();
    assert_eq!(stopper.join().unwrap(), started_pid);
    assert_eq!(store.phase(), LifecyclePhase::Empty);
}

#[test]
fn task_1_fix_actual_old_event_is_rejected_by_successor_channel() {
    let guard = acquire_process_spawn_guard();
    let mut old_command = Command::new(node());
    old_command
        .arg("-e")
        .arg("process.stdout.write('old-event')");
    let mut old = spawn_raw_engine(&guard, old_command).unwrap();
    let old_pid = old.pid();
    drop(guard);
    let held_old_event = loop {
        match old.recv_event_timeout(Duration::from_secs(2)).unwrap() {
            event @ RawEngineEvent::Stdout(_) => break event,
            _ => {}
        }
    };
    while !matches!(
        old.recv_event_timeout(Duration::from_secs(2)).unwrap(),
        RawEngineEvent::Terminated { .. }
    ) {}
    old.revoke_and_join(Duration::from_secs(1)).unwrap();

    let store = LifecycleStore::<u32, std::sync::mpsc::SyncSender<RawEngineEvent>, Vec<u8>>::new();
    let (old_public, old_public_receiver) = std::sync::mpsc::sync_channel(1);
    let (new_public, new_public_receiver) = std::sync::mpsc::sync_channel(1);
    let guard = acquire_process_spawn_guard();
    let old_generation = store.begin_start(&guard);
    store
        .install_live(&guard, old_generation, old_pid, old_public, Vec::new())
        .unwrap();
    let mut successor_command = Command::new(node());
    successor_command
        .arg("-e")
        .arg("setTimeout(() => process.exit(0), 40)");
    let successor = spawn_raw_engine(&guard, successor_command).unwrap();
    let successor_pid = successor.pid();
    let next_generation = store.begin_start(&guard);
    store
        .install_live(
            &guard,
            next_generation,
            successor_pid,
            new_public,
            Vec::new(),
        )
        .unwrap();
    drop(guard);
    assert!(!store.with_current_public(old_generation, |channel| {
        channel.try_send(held_old_event).unwrap();
    }));
    assert!(store.with_current_public(next_generation, |channel| {
        channel
            .try_send(RawEngineEvent::Stdout(b"new-event".to_vec()))
            .unwrap();
    }));
    assert!(old_public_receiver.try_recv().is_err());
    assert_eq!(
        new_public_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap(),
        RawEngineEvent::Stdout(b"new-event".to_vec())
    );
    successor.revoke_and_join(Duration::from_secs(1)).unwrap();
}

#[test]
fn task_1_private_channels_are_directional_cloexec_and_collision_safe() {
    let guard = acquire_process_spawn_guard();
    let mut channels = create_native_sidecar_channels(&guard).expect("create private channels");
    assert!(channels.all_four_original_pipe_ends_were_cloexec_before_command());

    let probes = probe_fixed_fd_collision_matrix(&guard).expect("collision matrix");
    assert_eq!(
        probes.len(),
        4,
        "own-target, other-target, swapped, and ordinary cases"
    );
    assert!(probes.iter().all(|probe| probe.safe), "{probes:?}");

    let sentinel = "PRIVATE-e8d9b2b80c72ad7ad77fd7f92eb95c11";
    let mut command = Command::new(node());
    command
        .arg(fixture())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    channels
        .prepare_command(&mut command)
        .expect("prepare fixed private fds");
    let mut raw = spawn_raw_engine_after(&guard, command, || channels.parent_after_spawn())
        .expect("spawn fixture");

    channels
        .control_writer
        .write_frame(sentinel.as_bytes())
        .expect("write control frame");
    assert_eq!(
        channels
            .action_reader
            .read_frame()
            .expect("read action frame"),
        sentinel.as_bytes()
    );

    let mut public = Vec::new();
    loop {
        match raw
            .recv_event_timeout(Duration::from_secs(10))
            .expect("raw event")
        {
            RawEngineEvent::Stdout(bytes) | RawEngineEvent::Stderr(bytes) => public.extend(bytes),
            RawEngineEvent::Error => panic!("raw engine error"),
            RawEngineEvent::Terminated { code, signal } => {
                assert_eq!((code, signal), (Some(0), None));
                break;
            }
        }
    }
    let public_text = String::from_utf8(public).expect("fixture output utf8");
    assert!(
        !public_text.contains(sentinel),
        "private action bytes reached a public engine event"
    );
    let report: serde_json::Value = serde_json::from_str(public_text.trim()).expect("fixture JSON");
    assert_eq!(report["sites"].as_array().map(Vec::len), Some(5));

    assert_eq!(
        read_private_frame(
            &mut Cursor::new(private_frame(ACTION_FRAME_TAG, b"ok")),
            ACTION_FRAME_TAG
        )
        .unwrap(),
        b"ok"
    );
    assert!(read_private_frame(
        &mut Cursor::new(private_frame(CONTROL_FRAME_TAG, b"wrong")),
        ACTION_FRAME_TAG
    )
    .is_err());
    assert!(read_private_frame(
        &mut Cursor::new([ACTION_FRAME_TAG, 0, 0, 0, 4, 1, 2]),
        ACTION_FRAME_TAG
    )
    .is_err());
    let mut oversized = vec![ACTION_FRAME_TAG];
    oversized.extend_from_slice(&((MAX_PRIVATE_PAYLOAD + 1) as u32).to_be_bytes());
    assert!(read_private_frame(&mut Cursor::new(oversized), ACTION_FRAME_TAG).is_err());
}

#[test]
fn task_1_node_children_and_grandchildren_inherit_no_private_fd() {
    let guard = acquire_process_spawn_guard();
    let mut channels = create_native_sidecar_channels(&guard).expect("create private channels");
    let mut command = Command::new(node());
    command
        .arg(fixture())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    channels
        .prepare_command(&mut command)
        .expect("prepare fixed private fds");
    let mut raw = spawn_raw_engine_after(&guard, command, || channels.parent_after_spawn())
        .expect("spawn fixture");
    channels
        .control_writer
        .write_frame(b"control-probe")
        .expect("control");
    assert_eq!(
        channels.action_reader.read_frame().expect("action"),
        b"control-probe"
    );

    let mut stdout = Vec::new();
    loop {
        match raw
            .recv_event_timeout(Duration::from_secs(10))
            .expect("raw event")
        {
            RawEngineEvent::Stdout(bytes) => stdout.extend(bytes),
            RawEngineEvent::Stderr(bytes) => {
                panic!("fixture stderr: {}", String::from_utf8_lossy(&bytes))
            }
            RawEngineEvent::Error => panic!("fixture raw error"),
            RawEngineEvent::Terminated { code, signal } => {
                assert_eq!((code, signal), (Some(0), None));
                break;
            }
        }
    }
    let report: serde_json::Value = serde_json::from_slice(&stdout).expect("fixture JSON");
    let sites = report["sites"].as_array().expect("site array");
    assert_eq!(sites.len(), 5);
    let names: Vec<_> = sites
        .iter()
        .map(|site| site["site"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "voice",
            "workspace",
            "private-store",
            "browser-engine",
            "cli-image-picker"
        ]
    );
    for site in sites {
        assert_eq!(site["actionClosed"], true, "{site}");
        assert_eq!(site["controlClosed"], true, "{site}");
        assert_eq!(site["grandchild"]["actionClosed"], true, "{site}");
        assert_eq!(site["grandchild"]["controlClosed"], true, "{site}");
        assert_eq!(site["grandchild"]["distinctProcess"], true, "{site}");
        assert_eq!(site["grandchildExit"], 0, "{site}");
        assert!(site["grandchildSignal"].is_null(), "{site}");
    }
}

#[test]
fn task_1_restart_is_one_atomic_launch_and_revokes_late_callbacks() {
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(Barrier::new(3));
    let mut joins = Vec::new();
    for _ in 0..2 {
        let active = Arc::clone(&active);
        let maximum = Arc::clone(&maximum);
        let gate = Arc::clone(&gate);
        joins.push(std::thread::spawn(move || {
            gate.wait();
            let _guard = acquire_process_spawn_guard();
            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
            maximum.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(20));
            active.fetch_sub(1, Ordering::SeqCst);
        }));
    }
    gate.wait();
    for join in joins {
        join.join().unwrap();
    }
    assert_eq!(
        maximum.load(Ordering::SeqCst),
        1,
        "start/start was not serialized"
    );

    let stop_store = Arc::new(LifecycleStore::<u32, Vec<Vec<u8>>, Vec<Vec<u8>>>::new());
    let starting = Arc::new(Barrier::new(2));
    let permit_install = Arc::new(Barrier::new(2));
    let start_store = Arc::clone(&stop_store);
    let start_ready = Arc::clone(&starting);
    let start_install = Arc::clone(&permit_install);
    let starter = std::thread::spawn(move || {
        let guard = acquire_process_spawn_guard();
        let generation = start_store.begin_start(&guard);
        start_ready.wait();
        start_install.wait();
        start_store
            .install_live(&guard, generation, 77, Vec::new(), Vec::new())
            .unwrap();
    });
    starting.wait();
    assert_eq!(stop_store.phase(), LifecyclePhase::Starting);
    let stopper_store = Arc::clone(&stop_store);
    let stopper = std::thread::spawn(move || {
        let guard = acquire_process_spawn_guard();
        let stopped = stopper_store.take_live_for_stop(&guard);
        stopper_store.finish_stop(&guard);
        stopped
    });
    std::thread::sleep(Duration::from_millis(20));
    permit_install.wait();
    starter.join().unwrap();
    assert_eq!(
        stopper.join().unwrap(),
        Some(77),
        "stop must observe the post-gap install"
    );
    assert_eq!(stop_store.phase(), LifecyclePhase::Empty);

    let store = Arc::new(LifecycleStore::<u32, Vec<Vec<u8>>, Vec<Vec<u8>>>::new());
    let guard = acquire_process_spawn_guard();
    let generation = store.begin_start(&guard);
    assert_eq!(store.phase(), LifecyclePhase::Starting);
    store
        .install_live(&guard, generation, 41, Vec::new(), Vec::new())
        .unwrap();
    drop(guard);

    assert!(store.with_current_control(generation, |sink| sink.push(b"old-wins".to_vec())));
    let guard = acquire_process_spawn_guard();
    let next = store.begin_start(&guard);
    assert!(!store.with_current_control(generation, |sink| sink.push(b"late-old".to_vec())));
    assert!(!store.with_current_public(generation, |sink| sink.push(b"stale-event".to_vec())));
    store
        .install_live(&guard, next, 42, Vec::new(), Vec::new())
        .unwrap();
    drop(guard);
    assert!(store.with_current_control(next, |sink| sink.push(b"new".to_vec())));
    assert!(store.with_current_public(next, |sink| sink.push(b"new-event".to_vec())));
    let snapshot = store.snapshot_clone();
    assert_eq!(snapshot.live, Some(42));
    assert_eq!(snapshot.control_writer, Some(vec![b"new".to_vec()]));
    assert_eq!(snapshot.public_channel, Some(vec![b"new-event".to_vec()]));

    let state_entered = Arc::new(Barrier::new(2));
    let release_state = Arc::new(Barrier::new(2));
    let held_store = Arc::clone(&store);
    let held_entered = Arc::clone(&state_entered);
    let held_release = Arc::clone(&release_state);
    let state_holder = std::thread::spawn(move || {
        held_store.with_live(|_, _| {
            held_entered.wait();
            held_release.wait();
        });
    });
    state_entered.wait();
    let guard = acquire_process_spawn_guard();
    assert!(
        store.try_take_live_for_stop(&guard).is_err(),
        "panic fallback must not wait on a held lifecycle-state lock"
    );
    drop(guard);
    release_state.wait();
    state_holder.join().unwrap();

    let held = acquire_process_spawn_guard();
    assert!(
        try_acquire_process_spawn_guard().is_none(),
        "panic fallback must never deadlock"
    );
    drop(held);
}

#[test]
fn task_1_raw_launcher_drains_before_terminated_with_bounded_backpressure() {
    assert_eq!(RAW_EVENT_CAPACITY, 1);
    let guard = acquire_process_spawn_guard();
    let mut command = Command::new(node());
    command
        .arg("-e")
        .arg("process.stdout.write('out-a'); process.stderr.write('err-b');");
    let mut raw = spawn_raw_engine(&guard, command).expect("spawn raw child");
    drop(guard);
    let mut kinds = Vec::new();
    loop {
        let event = raw
            .recv_event_timeout(Duration::from_secs(5))
            .expect("event");
        match event {
            RawEngineEvent::Stdout(bytes) => kinds.push(("stdout", bytes)),
            RawEngineEvent::Stderr(bytes) => kinds.push(("stderr", bytes)),
            RawEngineEvent::Error => kinds.push(("error", Vec::new())),
            RawEngineEvent::Terminated { code, signal } => {
                assert_eq!((code, signal), (Some(0), None));
                kinds.push(("terminated", Vec::new()));
                break;
            }
        }
    }
    assert_eq!(kinds.last().unwrap().0, "terminated");
    assert!(kinds
        .iter()
        .any(|(kind, bytes)| *kind == "stdout" && bytes == b"out-a"));
    assert!(kinds
        .iter()
        .any(|(kind, bytes)| *kind == "stderr" && bytes == b"err-b"));
    assert_eq!(
        raw.force_kill(Duration::from_millis(100))
            .expect("post-reap kill check"),
        ForceKillResult::AlreadyExited,
        "the exclusive Child owner must never signal a reaped or reused PID",
    );

    let guard = acquire_process_spawn_guard();
    let mut noisy = Command::new(node());
    noisy
        .arg("-e")
        .arg("process.stdout.write('x'.repeat(200000));");
    let raw = spawn_raw_engine(&guard, noisy).expect("spawn noisy child");
    drop(guard);
    std::thread::sleep(Duration::from_millis(150));
    let began = Instant::now();
    raw.revoke_and_join(Duration::from_secs(2))
        .expect("revoke stalled generation");
    assert!(began.elapsed() < Duration::from_secs(2));

    let guard = acquire_process_spawn_guard();
    let mut channels = create_native_sidecar_channels(&guard).expect("channels");
    channels.parent_after_spawn();
    let began = Instant::now();
    assert!(channels
        .control_writer
        .write_frame(b"reader-is-gone")
        .is_err());
    assert!(
        began.elapsed() < Duration::from_secs(2),
        "stopped reader exceeded writer bound"
    );
}

/// A child that watches for EOF ends when the shell drops its stdin — no
/// signal, no kill, exit code 0. This is the ordinary path, and it is the one
/// that lets the engine save and take its own tool children down with it.
#[test]
fn closing_stdin_ends_a_child_that_watches_for_eof() {
    let process_guard = acquire_process_spawn_guard();
    let mut child = Command::new(node())
        .arg("-e")
        .arg("process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); setInterval(() => {}, 1000);")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    drop(process_guard);

    // Still running while the pipe is open — otherwise the next assertion
    // would pass for the wrong reason.
    assert!(wait_for_exit(&mut child, Duration::from_millis(300)).is_none());

    drop(child.stdin.take());

    let status = wait_for_exit(&mut child, Duration::from_secs(5))
        .expect("EOF must end a child that watches for it");
    assert_eq!(status.code(), Some(0), "an EOF exit is an ordinary exit");
    assert_eq!(status.signal(), None, "nothing had to be killed");
}

/// The fallback is SIGKILL, and SIGKILL cannot be trapped.
///
/// The child installs a SIGTERM handler that would leave a marker file. The
/// marker is never written, and the wait status reports signal 9 — which is
/// why the shell asks first and kills last: a SIGKILLed engine runs no
/// cleanup, and orcode's tool children sit in their own process groups.
#[test]
fn the_kill_fallback_is_an_untrappable_sigkill() {
    let marker = std::env::temp_dir().join(format!("orcode-gui-sigterm-{}", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let script = format!(
        "process.on('SIGTERM', () => {{ require('fs').writeFileSync({marker:?}, 'term'); process.exit(0); }}); process.stdin.resume(); setInterval(() => {{}}, 1000);",
        marker = marker.to_string_lossy(),
    );
    let process_guard = acquire_process_spawn_guard();
    let mut child = Command::new(node())
        .arg("-e")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    drop(process_guard);

    // This child deliberately ignores EOF: the interval keeps it alive, so
    // the grace window is what expires and the fallback is what ends it.
    drop(child.stdin.take());
    assert!(
        wait_for_exit(&mut child, Duration::from_millis(400)).is_none(),
        "the fixture must survive EOF, or it proves nothing about the fallback",
    );

    child.kill().expect("kill");
    let status = wait_for_exit(&mut child, Duration::from_secs(5)).expect("SIGKILL always lands");
    assert_eq!(
        status.signal(),
        Some(9),
        "Child::kill sends SIGKILL, not SIGTERM"
    );
    assert!(
        !marker.exists(),
        "a SIGTERM handler must NOT have run — SIGKILL gives a process no chance to clean up",
    );
    let _ = std::fs::remove_file(&marker);
}

/// The line framing the protocol depends on: one JSON object per line, and a
/// child reading `readline` sees exactly the lines the shell wrote.
#[test]
fn the_shell_writes_one_frame_per_line() {
    let process_guard = acquire_process_spawn_guard();
    let mut child = Command::new(node())
        .arg("-e")
        .arg("let n = 0; require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => { n += 1; if (JSON.parse(line).t === 'shutdown') { console.log(String(n)); process.exit(0); } });")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    drop(process_guard);

    {
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(b"{\"v\":1,\"t\":\"hello-ack\",\"id\":\"a\"}\n")
            .expect("write");
        stdin
            .write_all(format!("{}\n", orcode_gui_lib::engine::SHUTDOWN_REQUEST).as_bytes())
            .expect("write");
        stdin.flush().expect("flush");
    }

    let output = child.wait_with_output().expect("wait");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "2",
        "two writes must arrive as exactly two lines",
    );
}
