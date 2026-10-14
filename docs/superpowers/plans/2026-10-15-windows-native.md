# Native Windows App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den vollständigen lokalen orcode-Ablauf als native Windows-11-x64-App mit eigener Runtime, geschützter Arbeitskopie, manueller Modellwahl und bestätigtem Apply ausliefern, ohne WSL.

**Architecture:** Die bestehende Tauri-GUI und der TypeScript-Core bleiben erhalten. Eine kleine Rust-Plattformschicht übernimmt Windows-Dateiidentität, Named Pipes, Job Objects und AppContainer; ein privater `orcode-platform-host.exe` vermittelt diese Funktionen an den Core. Der Vermittler ist ein überwachtes Kind der Engine, keine zweite Setup-Autorität und kein zusätzlicher Server.

**Tech Stack:** Tauri 2, TypeScript, Node **24.22.0 win-x64**, Rust/MSVC mit bestehendem Minimum **1.88**, zielgebunden `windows-sys = "=0.61.2"`, NTFS, NSIS, WebView2. Keine zusätzliche Laufzeitinstallation durch den Nutzer außer dem vom Installer angebotenen offiziellen WebView2-Setup.

**Spec:** [2026-10-15-windows-native-design.md](../specs/2026-10-15-windows-native-design.md), vom Nutzer am 15.10.2026 freigegeben.

**Ausgangscommit:** `af8fdd560aebd8bbcee4456f5f8928cfe77160fd`, Branch `codex/orcode-workbench-2026-10-12`. Dieser Plan ist noch keine Implementierung.

## Global Constraints

- Windows 11 x64 ist das erste Abnahmeziel; Windows ARM64, Windows 10 und Server werden nicht implizit als getestet bezeichnet.
- Keine WSL-, Docker-, Hyper-V- oder globale Node-Installation als Voraussetzung.
- AI-Prozess und Permissions bleiben unabhängig. Das Lead-Modell wählt immer der Nutzer. Der aktuelle Auto-Ablauf plant und implementiert mit diesem Lead; dynamische Mehragenten-Orchestrierung wird durch diese Portierung nicht erfunden.
- Permissions behalten ihre sichtbare, aktionsgebundene Bedeutung. Keine automatische Administratorfreigabe, Provider-Installation oder finale Übernahme.
- Abo-first, kein bezahlter API-Fallback, kein Credential-Export und keine Überlassung persönlicher Abos an andere Nutzer.
- macOS bleibt unterstützt. Keine pauschale Lockerung bisheriger Schutzgrenzen.
- Kein SSH-/VPN-/Cluster-Modul, keine neuen Remote-Hosts und kein öffentlicher Release ohne bestandene Plattformabnahme.
- Öffentliche GUI-Frames bleiben secretless.
- Das erste unterstützte Projekt-Dateisystem ist lokales NTFS mit regulären, vollständig lokal verfügbaren Dateien.
- Scheitert die Probe oder fehlen OS-Fähigkeiten, wird Ausführung gesperrt. Kein Fallback auf ungeschütztes PowerShell/cmd und kein Ersatz durch WSL.
- Claude/Kimi bleiben extern, bis ein tatsächlicher GUI-Turn-Adapter geprüft ist.
- Keine Credentials oder Live-Accounts in Hosted CI.
- Code-Signing-Zertifikate werden nicht gekauft, ersetzt oder aus CI exportiert.

## Review Focus

1. Explorer-/Startmenü-Start ohne brauchbaren PATH, mit Umlauten und Leerzeichen: App, Runtime, Projektwahl und Cancel funktionieren ohne globales Node. Tests: Task 1 und Task 7.
2. Ein anderer Prozess desselben Benutzers oder eine alte Engine-Generation verbindet sich zuerst oder antwortet spät: keinerlei Setup-Freigabe, keine Geheimnisse, begrenzter Abbruch. Tests: Task 2.
3. Junction-/Hardlink-/Case-/ADS-Aliase sowie Dateitausch während Apply oder Recovery: Original und fremde Änderungen bleiben erhalten; Objektidentität schlägt Pfadbehauptung. Tests: Task 3 und Task 5.
4. Kindprozesse, Shells oder AppContainer-Profilverzeichnisse erlauben unerwartete Schreib-/Netzwerkzugriffe: der echte Canary sperrt Ausführung; Stop und App-Absturz hinterlassen keine Worker. Tests: Task 4.
5. Antivirus/Sharing-Verletzung oder Absturz zwischen Journal-Flush und zweiter Dateiänderung: keine falsche Erfolgsmeldung, keine automatische Wiederaufnahme, nachvollziehbare erhaltene Vorherbilder. Tests: Task 3, Task 5 und Task 8.

---

## Etappen und Ausführung

| Etappe | Aufgaben | Nutzbares Ergebnis | Noch gesperrt |
| --- | --- | --- | --- |
| A | 1–2, 7 | Native Vorschau startet mit eigener Runtime und geprüfter privater Verbindung | Coding/Apply bis zur Sicherheitsabnahme |
| B | 3–5 | Echter lokaler Ablauf mit Windows-Dateigrenzen, Sandbox, Stop und Recovery | Nicht geprüfte Provider und öffentliche Freigabe |
| C | 6, 8 | Hersteller-Setup, vollständige Artefaktabnahme und dokumentierte Anbietergrenzen | Release ohne reale Abnahme oder erforderliche Signatur |

Task 1 → 2 → 3 → 4 → 5 sind wegen ihrer Verträge nacheinander auszuführen.
Task 6 kann nach Task 2 unabhängig von Task 3–5 entstehen. Task 7 kann nach
Task 2 parallel erfolgen. Task 8 integriert die Ergebnisse. Ein grüner Teilstand
schaltet keine spätere Sicherheitsstufe frei.

Empfohlen: Native-Ausführung in diesem Chat mit einem frischen unabhängigen
Review am Ende; gezielte read-only Fachprüfungen bei Windows-Sicherheitsgrenzen.
Das vermeidet einen frischen Implementierer-Kontext pro kleiner Änderung.

Vor dem Start `git status --short` und `git rev-parse --git-dir
--git-common-dir` prüfen. Unverwandte Änderungen bleiben unangetastet. Beim
Erstellen einer isolierten Arbeitsumgebung gilt `superpowers:using-git-worktrees`.
Jede Aufgabe hat einen Rot-Grün-Zyklus und einen eigenen Commit. Keine Tests
umetikettieren, damit Windows grün erscheint.

## Dateien und Verantwortlichkeiten

Neue Dateien werden nach Verantwortung klein gehalten:

| Datei oder Verzeichnis | Verantwortung |
| --- | --- |
| `gui/src-tauri/src/platform/mod.rs` | Gemeinsame OS-Schnittstellen, keine Tauri-/WebView-Autorität |
| `gui/src-tauri/src/platform/unix.rs` | Bestehende Unix-FD-, Spawn- und Drain-Primitiven unverändert |
| `gui/src-tauri/src/platform/windows/{mod,identity,pipe,job,filesystem,sandbox}.rs` | Windows-Identitäten, IPC, Prozesse, Dateien, Sandbox |
| `gui/src-tauri/src/bin/orcode-platform-host.rs` | Geschlossener privater Dispatcher und Pipe-Proxy; kein WebView-Endpunkt |
| `gui/src-tauri/src/native_owner.rs` | Windows-Bootstrap, Generation, Challenge und Widerruf |
| `gui/src-tauri/src/native_presentation.rs` | Plattformgebundene physische Besitzerbestätigung |
| `gui/src-tauri/build_support/packaged_policy_macos.rs` | Bisherige Mac-Policy-Prüfung ohne Windows-Attrappen |
| `src/native-platform-{protocol,port}.ts` | Geschlossener privater RPC-Vertrag, Grenzen und Client |
| `src/native-owner-bootstrap.ts` | Separater Windows-Bootstrap und private Sitzungsmarke |
| `src/windows-file-boundary.ts` | Windows-Backend für bestehende Workspace-/Snapshot-Verträge |
| `src/local-run-journal.ts` | Versioniertes Runjournal, Plattformadapter und Recovery |
| `src/windows-local-process-isolation.ts` | Canary, native Run-Lease und Windows-Prozess-RPC |
| `src/official-cli-host-{macos,windows}.ts` | Herkunft und feste Statusaufrufe pro Plattform |
| `scripts/gui-platform.mjs`, `scripts/gui-platform.d.mts` | Testbare und typisierte Build-/Paketentscheidungen ohne Seiteneffekte beim Import |
| `scripts/gui-runtime.windows.json` | Versions- und Hashbindung der Windows-Runtime |
| `gui/src-tauri/tauri.windows.conf.json` | Windows-Ressourcen, Icon und NSIS-Konfiguration |
| `.github/workflows/windows-gui.yml` | Windows-Build und accountfreie native Verifikation |
| `docs/windows-acceptance.md` | Tatsächlich ausgeführte Abnahme pro Artefakthash |

## Gemeinsame Verträge

Diese Typen werden in Task 2–4 definiert; spätere Aufgaben importieren sie,
statt ähnliche lokale Varianten anzulegen. Roh-HANDLEs sind niemals JSON.

```ts
// src/native-platform-port.ts
import type {ProcessResult} from './workspace.js';

export type NativeRef = string;
export type NativePurpose = 'project'|'app-home'|'work'|'scratch';
export type WinIdentity = Readonly<{
  volumeSerialHex:string; fileId128Hex:string; kind:'file'|'directory';
}>;
export type RootBinding = Readonly<{
  ref:NativeRef; canonicalPath:string; identity:WinIdentity;
}>;
export type RunLease = Readonly<{
  ref:NativeRef; runId:string; epoch:number; generation:string;
}>;
export type NativeFile = Readonly<{
  path:string; bytes:Uint8Array; sha256:string;
  metadata:Readonly<{kind:'windows';attributes:number;securityDigest:string}>;
}>;
export type NativeEffect = Readonly<{
  path:string; before:NativeFile|null; after:Uint8Array|null;
}>;
export type CanaryEvidence = Readonly<{
  passed:boolean; osBuild:string; runtimeSha256:string;
  checks:Readonly<Record<string,boolean>>;
}>;
export type ToolSpec = Readonly<{
  executableRef:NativeRef; argv:readonly string[]; cwdRef:NativeRef;
  env:Readonly<Record<string,string>>; timeoutMs:number;
}>;
export type NativeChunk = Readonly<{
  stream:'stdout'|'stderr'; text:string;
}>;
export type PublishResult = Readonly<{
  outcome:'applied'|'conflict'|'blocked-recovery'; journalRevision:number;
}>;
export interface NativePlatformPort {
  openNtfsRoot(path:string,purpose:NativePurpose):Promise<RootBinding>;
  createPrivateRun(homeRef:NativeRef,runId:string):Promise<{
    lease:RunLease;journalRef:NativeRef;work:RootBinding;scratch:RootBinding;
  }>;
  readPrivateJournal(journalRef:NativeRef,maxBytes:number):Promise<Uint8Array>;
  writePrivateJournal(journalRef:NativeRef,revision:number,bytes:Uint8Array):
    Promise<{revision:number;sha256:string}>;
  snapshotTree(rootRef:NativeRef):Promise<readonly NativeFile[]>;
  copyWorkspace(sourceRef:NativeRef,destinationRef:NativeRef):Promise<void>;
  inspectExecutable(path:string):Promise<{ref:NativeRef;sha256:string}>;
  prepareSandbox(lease:RunLease,binaries:readonly NativeRef[]):Promise<CanaryEvidence>;
  executeTool(lease:RunLease,spec:ToolSpec,signal:AbortSignal,
    onChunk:(chunk:NativeChunk)=>void):Promise<ProcessResult>;
  retireRun(lease:RunLease):Promise<{retiredEpoch:number}>;
  quiesceRun(lease:RunLease,drainMs:number):Promise<{treeEmpty:boolean}>;
  publishExact(lease:RunLease,originalRef:NativeRef,candidateHash:string,
    effects:readonly NativeEffect[],journalRef:NativeRef):Promise<PublishResult>;
  close():void;
}
```

Task 3 definiert zusätzlich folgende Journal-Schnittstelle. Native Referenzen
bleiben an die tatsächliche Core-Verbindung gebunden. Ein aus einem Journal
gelesener Identifikator ist keine wiederverwendbare Autorität; bei Recovery
werden die Objekte neu geöffnet und geprüft.

```ts
// src/local-run-journal.ts
import type {LocalCandidate} from './local-project-run.js';
import type {WinIdentity} from './native-platform-port.js';
export type LocalFileMetadata =
  | Readonly<{kind:'posix';mode:number}>
  | Readonly<{kind:'windows';attributes:number;securityDigest:string}>;
export type JournalRoot = Readonly<{
  canonicalPath:string;
  identity:WinIdentity|Readonly<{kind:'posix';dev:string;ino:string}>;
}>;
export type LocalRunRecordV2 = Readonly<{
  schemaVersion:2;revision:number;sessionId:string;state:LocalCandidate;
  appHome:JournalRoot;original:JournalRoot;work:JournalRoot;scratch:JournalRoot;
  baseline:readonly Readonly<{path:string;bytesBase64:string;metadata:LocalFileMetadata}>[];
}>;
export interface LocalRunJournal {
  create(input:{appHome:string;originalRoot:string;sessionId:string}):
    Promise<{journalPath:string;record:LocalRunRecordV2}>;
  read(journalPath:string,maxBytes:number):Promise<LocalRunRecordV2>;
  write(journalPath:string,record:LocalRunRecordV2,expectedRevision:number):
    Promise<LocalRunRecordV2>;
  discover(appHome:string,sessionId:string,originalRoot:string):
    Promise<readonly {journalPath:string;record:LocalRunRecordV2}[]>;
}
```

Alle neu angelegten rein nativen Windows-Tests nutzen einen einzelnen
`skip: process.platform !== 'win32'` an ihrer Testgrenze. Auf Windows sind diese
Tests verpflichtend und dürfen nicht wegen fehlender Schutzfunktionen skippen.
Plattformneutrale Codecs und State-Machine-Tests laufen auf allen OS; bestehende
gemeinsame Tests werden nicht insgesamt deaktiviert.

### Task 1: OS-Primitiven trennen und einen begrenzten Windows-Build erzeugen

**Files:**

- Create: `gui/src-tauri/src/platform/mod.rs`, `platform/unix.rs`, `platform/windows/mod.rs`.
- Create: `gui/src-tauri/build_support/packaged_policy_macos.rs`, `scripts/gui-platform.mjs`, `scripts/gui-platform.d.mts`, `tests/gui-platform.test.ts`.
- Modify: `gui/src-tauri/{Cargo.toml,Cargo.lock,build.rs}`, `gui/src-tauri/src/{engine.rs,lib.rs}`, `scripts/gui.mjs`.
- Modify/Test: `gui/src-tauri/tests/engine_lifecycle.rs`, `gui/src-tauri/src/engine.rs` tests.

**Interfaces:** Consumes existing `RawEngine`, `RawProcessOwnership`,
`NativeSidecarChannels`, `LifecycleStore` and `EngineProcess`. Produces OS-neutral
exit status, runtime resolution and cfg-selected implementations without changing
public lifecycle method signatures. New JS `guiPlatform(platform,arch,home,path)`
returns `{nodeName,pathValue,bundles,runtimeSupported}`.

- [ ] **Step 1: Add the failing platform decision tests.**

```ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {guiPlatform} from '../scripts/gui-platform.mjs';
test('Windows x64 needs neither HOME nor colon-separated PATH',()=>{
  const p=guiPlatform('win32','x64','C:\\Users\\Test User','C:\\Windows\\System32');
  assert.equal(p.nodeName,'node.exe');
  assert.deepEqual(p.bundles,['nsis']);
  assert.match(p.pathValue,/;C:\\Windows\\System32$/);
  assert.equal(p.runtimeSupported,true);
});
test('unsupported Windows architecture is not a supported runtime',()=>{
  assert.equal(guiPlatform('win32','arm64','C:\\Users\\Test','').runtimeSupported,false);
});
```

- [ ] **Step 2: Run red, then extract the platform decisions.**

Run `node --import tsx --test tests/gui-platform.test.ts`; expected missing
module/export. Implement the pure return values with `path.win32` for Windows,
`path.posix` for Unix and `os.homedir()` at the caller. Use `process.execPath`
plus resolved `npm-cli.js` for script execution, not a PATH-resolved `npm.cmd`
or `shell:true`. Reject missing CLI script explicitly.

```js
export function guiPlatform(platform,arch,home,pathValue) {
  const windows=platform==='win32';
  const separator=windows?';':':';
  const cargo=windows?`${home}\\.cargo\\bin`:`${home}/.cargo/bin`;
  return {nodeName:windows?'node.exe':'node',pathValue:`${cargo}${separator}${pathValue}`,
    bundles:windows?['nsis']:['app','dmg'],
    runtimeSupported:platform==='darwin'||(windows&&arch==='x64')};
}
```

```ts
// scripts/gui-platform.d.mts
export function guiPlatform(platform:string,arch:string,home:string,pathValue:string):{
  nodeName:string;pathValue:string;bundles:string[];runtimeSupported:boolean;
};
```

- [ ] **Step 3: Move platform primitives with behavior-preserving exports.**

Move `pipe_cloexec`, fixed-FD duplication, `pre_exec`, `FIONREAD`, nonblocking
write and `ExitStatusExt` use to `platform/unix.rs`. `engine.rs` retains framing,
queue bounds and lifecycle. Use `std::env::split_paths`, native `node.exe` and
`USERPROFILE`/Known Folders instead of splitting `:` or assuming HOME. Unix tests
receive `#[cfg(unix)]` only when they genuinely exercise Unix primitives;
platform-neutral lifecycle tests stay active everywhere.

```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "=0.61.2", features = [
  "Win32_Foundation", "Win32_Security", "Win32_Security_Authorization",
  "Win32_Security_Isolation", "Win32_Storage_FileSystem", "Win32_System_IO",
  "Win32_System_JobObjects", "Win32_System_Pipes", "Win32_System_Threading",
  "Win32_System_Memory", "Win32_System_Environment", "Win32_System_LibraryLoader",
  "Win32_UI_Shell", "Win32_UI_WindowsAndMessaging"
] }
```

Move the existing `compile_policy()` unchanged to the Mac-only build-support
module. A Windows build with `ORCODE_GUI_PACKAGED_TRUST_POLICY` set to a Mac
policy fails explicitly; an unset policy does not fabricate `VerifiedPackagedApp`.
Until Task 2, Windows native control and integrated execution return unavailable.

- [ ] **Step 4: Verify on Mac and the Windows runner.**

Run root/test TSC, `tests/gui-platform.test.ts`, existing GUI build, and
`cargo test --manifest-path gui/src-tauri/Cargo.toml --locked --lib` on Mac.
On Windows run `cargo check --manifest-path gui/src-tauri/Cargo.toml --locked
--target x86_64-pc-windows-msvc`. No GUI-ready claim from cross-check alone.

- [ ] **Step 5: Commit** `refactor: isolate desktop platform primitives`.

### Task 2: Prozessbesitz und privater Windows-Bootstrap

**Files:**

- Create: `platform/windows/{identity,pipe,job}.rs`, `src/bin/orcode-platform-host.rs`, `src/native_owner.rs` under `gui/src-tauri/`.
- Create: `src/native-platform-{protocol,port}.ts`, `src/native-owner-bootstrap.ts`.
- Create/Test: `gui/src-tauri/tests/windows_native.rs`, `gui/src-tauri/tests/fixtures/windows-native-child.mjs`, `tests/native-platform-protocol.test.ts`, `tests/native-owner-bootstrap.test.ts`.
- Modify/Test: `gui/src-tauri/src/{engine.rs,lib.rs}`, `src/{native-sidecar-channel.ts,gui-server.ts}`, existing native-channel/action tests.

**Interfaces:** Produces `NativePlatformPort` transport, an implementation of
existing `NativeSidecarTransport`, and Rust `NativeOwnerBinding` with private
fields for exact engine, helper, pipe-instance and generation identities.
The helper imports the pure platform modules, not Tauri startup. Cargo defines
its binary and `default-run = "orcode-gui"` to keep `cargo run` unambiguous.

- [ ] **Step 1: Pin Windows bootstrap and reject Mac-record widening.**

Define separate exact-key `WindowsOwnerHelloV1` and
`WindowsOwnerAttestationV1` records. Hello contains `kind`, `version:1`,
`requestId`, `sessionId`, `challenge`, `childPid`, `childGeneration`,
`pipeInstanceId`, `deadlineAt`. Attestation echoes those bindings and adds
canonical decimal creation times for engine/helper/owner, helper/owner PIDs and
`ownerImageSha256`. Never put unsafe 64-bit integers in JS numbers.

```ts
// Test inputs are fixture values, not real owner proofs.
test('Windows attestation is exact, generation-bound and single-use',()=>{
  const gate=new WindowsOwnerGate({generation:7,now:()=>100});
  const hello=gate.hello({childPid:1000,deadlineAt:200});
  const reply=ownerReplyForTest(hello); // local exact-key fixture in this test file
  assert.throws(()=>gate.accept({...reply,childGeneration:6}));
  assert.throws(()=>gate.accept({...reply,rawHandle:'forged'}));
  gate.accept(reply);
  assert.throws(()=>gate.accept(reply));
});
```

Implement `WindowsOwnerGate.hello/accept/revoke` in
`native-owner-bootstrap.ts`. `accept` validates only exact syntax/correlation;
it does not mint a production native owner capability. Only the private port,
after real native peer verification, may combine this with native evidence and
create the unexported runtime brand. Unit fixtures cannot construct that brand.
Run tests red before implementing the gate. Use this exact local fixture:

```ts
function ownerReplyForTest(hello:WindowsOwnerHelloV1):WindowsOwnerAttestationV1 {
  return {...hello,kind:'windows-owner-attestation',childCreationTime:'100',
    peerPid:1001,peerCreationTime:'101',ownerPid:999,ownerCreationTime:'99',
    ownerImageSha256:'1'.repeat(64)};
}
```

- [ ] **Step 2: Create owned processes before executing any instruction.**

Add `spawn_native_engine(guard,generation,Command) -> NativeEngineLaunch`.
It returns existing raw engine/channel owners plus the private binding.
Windows uses suspended creation, exact inherited-handle allowlist, Job assignment,
then resume. Configure `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, no breakaway; hold
process handles and creation times, not just PIDs. Failure to associate kills
and reaps the still-suspended process. Preserve the existing atomic lifecycle
start/drain/restart contracts and bounded I/O.

```rust
// job.rs launch ordering; owned handles close on every error path.
let child = create_suspended(command, inherited_handles)?;
if let Err(error) = job.assign(&child) {
    child.terminate_and_wait()?;
    return Err(error);
}
child.resume()?;
```

Define those three methods in `job.rs`; test their observable ordering with a
child whose first action writes a marker and spawns a grandchild. Windows exits
report `signal: None`; do not fabricate Unix signals.

- [ ] **Step 3: Implement one native-authenticated control path.**

Create first-instance local-only duplex Named Pipe before children. Apply an
explicit protected DACL. The helper owns the client and calls native
`GetNamedPipeServerProcessId`; the shell checks the actual helper client,
retained process creation time, trusted image, SID, engine Job membership and
bound Core generation. **Pipe peer = helper; engine identity = Core.** Never
compare the client PID to the Core PID by mistake. Retain/bind both identities.

The helper proxies private A1/C1 frames over its dedicated stdin/stdout;
Core stdout remains the public GUI protocol. Existing payload limit 4096,
one control reader, 500-ms write grace and stale-generation revocation remain.
Mac `fromFixedDescriptors()` and Kimi fixed-FD attestation remain unchanged.
Windows startup must not call Mac `consumePackagedStartup()`.

The same helper channel carries a closed `NativePlatformRequest` union with
request ID and generation; no arbitrary native method name, command template or
raw handle. Large file data uses sequential chunks of at most 2048 decoded
bytes, total size/hash declared before transfer: 32 MiB per staging file,
512 MiB/tree and 100,000 entries, matching `codex-staging-workspace.ts`.
Interactive file-tool reads retain their stricter 1,500,000-byte limit;
journals retain the 720 MiB parse ceiling. Reject duplicate, out-of-order,
oversized and post-cancel chunks. Queue
depth 32, at most one active mutating filesystem operation per run; cancellation
and retire requests bypass ordinary backlog. No helper trace goes to GUI output.

- [ ] **Step 4: Run real negative peer and lifecycle tests.**

In `windows_native.rs` add `windows_pipe_rejects_foreign_peer`,
`windows_bootstrap_rejects_replay_generation_and_expiry`,
`windows_spawn_is_job_owned_before_resume`,
`windows_job_kills_grandchildren_on_shell_abort`,
`windows_tools_inherit_no_setup_or_job_handles` and
`windows_cancelled_pipe_io_joins_boundedly`. Child fixture modes are
`owner-bootstrap`, `foreign-peer`, `stalled-control`, `hold-inherited-stdio`,
`spawn-grandchild`, `crash`; none needs an account.

Run `cargo test --manifest-path gui/src-tauri/Cargo.toml --locked --test
windows_native` on Windows; run existing native sidecar/native-shell/official
action TS suites on both platforms. Required Windows tests fail, not skip, if
the capability is unavailable.

- [ ] **Step 5: Commit** `feat: add owned Windows engine and private native bridge`.

### Task 3: NTFS-Dateigrenzen und dauerhafte private Runjournale

**Files:**

- Create: `platform/windows/filesystem.rs`, `src/windows-file-boundary.ts`, `src/local-run-journal.ts`.
- Create/Test: `tests/windows-file-boundary.test.ts`, `tests/windows-private-run-journal.test.ts`, `tests/fixtures/windows-platform-fixture.ts`.
- Modify/Test: `src/{private-store.ts,workspace.ts,codex-staging-workspace.ts,local-project-run.ts,native-platform-port.ts}`, `tests/{local-project-run,private-store-identity-races}.test.ts`.

**Interfaces:** Implements root/private-file/snapshot operations on
`NativePlatformPort` and the exact `LocalRunJournal` interface above. Schema 1
journals remain readable on Mac; the POSIX adapter normalizes them to the v2
in-memory record without inventing Windows metadata. Windows writes schema 2
with discriminated Windows metadata and trusted root revalidation.

`createWindowsFixture()` in the test fixture starts the real built helper and
returns `{port,original,appHome,work,scratch,lease,journalRef,dispose}`; roots are
real temporary local NTFS directories with space/Unicode names. `dispose()`
closes the helper and removes only those identified fixture directories.

- [ ] **Step 1: Add account-free alias and journal-negative tests, then run red.**

```ts
test('Windows aliases cannot create a second publication path',
  {skip:process.platform!=='win32'},async(t)=>{
  const f=await createWindowsFixture();t.after(()=>f.dispose());
  for(const path of ['C:relative','\\\\server\\share','\\\\?\\GLOBALROOT\\Device',
    f.original.canonicalPath+'\\a.txt:stream']) {
    await assert.rejects(f.port.openNtfsRoot(path,'project'));
  }
  const bytes=Buffer.from('{"schemaVersion":2}');
  const saved=await f.port.writePrivateJournal(f.journalRef,0,bytes);
  await assert.rejects(f.port.writePrivateJournal(f.journalRef,0,bytes));
  assert.equal(saved.revision,1);
});
```

Add real hardlink, junction, reparse-component, placeholder, reserved-name,
trailing-dot/space, case-collision, cross-volume and ancestor-swap cases.
Check unchanged outside bytes **and DACL digests** after rejection. Add malformed,
oversized, replaced-object and broad-inherited-ACE journal tests.

- [ ] **Step 2: Implement native handle-bound operations, not string guards.**

Use `CreateFileW` reparse-aware opens, full volume/file ID, final path, filesystem
type and security descriptor from the opened object. Retain parent/object
handles through effects. Reject any unproved filesystem, alias or mutation
strategy; a final-path check followed by ordinary path write is insufficient.
Snapshot/copy/baseline in `codex-staging-workspace.ts` use this same backend.
Do not leave a second unguarded Windows copy path.

Use `LocalFileMetadata` from the shared contract. Hash discriminated metadata,
not Windows `mode & 0o100`. Native bindings keep expected original security
and expected workcopy security separately: adding the worker SID during copy
must not be misinterpreted as a requested original DACL change. Never copy that
worker SID ACL into the original. Preserve original metadata; unsupported
streams or user-requested metadata changes produce an explicit conflict.

- [ ] **Step 3: Replace journal POSIX assumptions.**

`LocalProjectRun.create/recover/restoreLatest/persist` use `LocalRunJournal`.
Windows creates protected owner/SYSTEM-only objects before content, writes an
exclusive protected temporary, flushes, identity-bound replaces, reopens and
checks content/revision. No blanket success on failed flush/replace; no assumed
POSIX directory fsync on Windows. Persist pre-images before any original effect.
Recovery validates schema, limits, app-home identity, root identities and session;
serialized native refs are discarded. It restores `stopped`, clears test binding
and increments stop epoch, with no process dispatch.

- [ ] **Step 4: Verify crash/replacement behavior and Mac compatibility.**

Kill the real helper at controlled pre-flush/pre-replace/post-replace hooks.
Expected: valid old/new journal or explicit blocked recovery, never executed work.
Denied sharing/flush tests must report an error and retain recoverable pre-images.
Run new Windows suites plus `tests/local-project-run.test.ts`, private-store
identity-races and staging-workspace suites on Windows; run existing POSIX suites
on Mac. Pure state-machine tests use an explicit injected journal/isolation port,
while real OS tests remain separate; no broad Windows/Linux test skip.

- [ ] **Step 5: Commit** `feat: bind Windows workspaces and run journals to native objects`.

### Task 4: AppContainer-Ausführung und vollständigen Prozess-Stop nachweisen

**Files:**

- Create: `platform/windows/sandbox.rs`, `src/windows-local-process-isolation.ts`.
- Create/Test: `tests/windows-local-process-isolation.test.ts`, `tests/windows-process-stop.test.ts`.
- Modify/Test: `platform/windows/job.rs`, `src/{local-process-isolation.ts,workspace.ts,local-project-run.ts,native-platform-port.ts}`, existing process tests.

**Interfaces:** Implements `prepareSandbox`, `executeTool`, `retireRun`,
`quiesceRun`. Keep the Darwin facade behavior. Windows execution returns the
existing `ProcessResult` and streamed chunks via RPC, not an unprotected command
line from `isolatedLaunch()`. No model or test can supply a production port.

- [ ] **Step 1: Add real containment and lifecycle canaries; run red on Windows.**

```ts
test('Stop retires a lease and leaves no descendant alive',
  {skip:process.platform!=='win32'},async(t)=>{
  const f=await createWindowsFixture();t.after(()=>f.dispose());
  const retired=await f.port.retireRun(f.lease);
  assert.ok(retired.retiredEpoch>f.lease.epoch);
  assert.equal((await f.port.quiesceRun(f.lease,500)).treeEmpty,true);
  await assert.rejects(f.port.prepareSandbox(f.lease,[]));
});
```

Also run actual processes before retiring: one child forks a grandchild that
holds output open and attempts breakaway. Record native process handles and
assert all are signaled, rather than interpreting the parent exit code as proof.

- [ ] **Step 2: Create the per-run low-privilege process boundary.**

Use a unique AppContainer SID, no general network capability, only declared
work/scratch write grants and verified runtime/system read grants. Minimal
environment contains no provider tokens, profile directories or control pipe.
Create via `STARTUPINFOEX` security capabilities and exact handle allowlist,
inside the run Job before execution. The helper remains inside the shell-owned
engine Job. Never grant the worker access to the original or private app home.

AppContainer profile creation may create its own storage. Probe it explicitly.
If any location outside the declared run scratch is writable, execution stays
blocked and the finding returns for design correction; do not silently expand
the trusted writable set. Existing broad application-package ACEs are tested,
not assumed harmless. PowerShell/cmd/DLL/JIT incompatibility also blocks rather
than dropping containment.

- [ ] **Step 3: Bind canary and execution to exact identities.**

For bundled Node, native `cmd.exe` and explicitly discovered PowerShell, prove
work/scratch writes succeed and writes to original, sibling, app home, generic
temp and link escapes fail, directly and through descendants. Test token/SID,
unexpected inherited handles, foreign pipe access and host-controlled IPv4/IPv6
TCP/UDP endpoints, both loopback and interface address. Verify the host listener
is reachable before interpreting a worker failure as isolation.

`CanaryEvidence.passed` is true only when every named check is true. Bind it to
OS build, runtime hash, root identities, lease epoch and native generation. Any
replacement or resume requires a fresh proof. A wrapper's nonzero exit is not
containment evidence.

- [ ] **Step 4: Integrate Stop before asynchronous persistence.**

Core immediately retires local dispatch state; native `retireRun` invalidates
the shared native epoch before returning. Publication checks that epoch between
effects. Then bounded cooperative drain, termination and whole-Job emptiness
proof occur. Stop/timeout never use a single-PID Windows fallback. Helper EOF,
engine death and app death close owned Jobs. Stop during canary, launch, tool,
test, journal and Apply cannot be overwritten by a late completion.

Run both new Windows suites and existing process/local-isolation tests. Required
real Windows canaries fail if unsupported. Run Mac containment to prevent
regression. Keep legacy non-local-run behavior unchanged but do not describe its
older Windows process handling as newly protected.

- [ ] **Step 5: Commit** `feat: enforce Windows local process isolation and stop fences`.

### Task 5: Arbeitskopie, Test, Diff, Apply und Recovery verbinden

**Files:**

- Create/Test: `tests/windows-workspace-publication.test.ts`.
- Modify/Test: `src/{workspace.ts,local-project-run.ts,gui-server.ts}`, `platform/windows/filesystem.rs`.
- Modify/Test: `tests/fixtures/gui-server-harness.mjs`, `tests/gui-desktop-journey.test.ts`, `tests/gui-server-protocol.test.ts`, `gui/tests/execution-controls.test.ts`.

**Interfaces:** Implements `publishExact`; preserves existing one-shot
`consumeLocalPublication`, `LocalCandidate`, opaque GUI candidate handle and
policy revision. Windows metadata stays in Core/native contracts, not GUI
authority. The shared `LocalCandidate` shape need not gain raw native references.

- [ ] **Step 1: Pin explicit Apply and foreign-edit behavior.**

```ts
test('an intervening original edit cannot be overwritten',async()=>{
  const {original,appHome}=await fixture(); // existing local-run fixture
  const run=await LocalProjectRun.create({originalRoot:original,appHome});
  await writeFile(join(run.view().workRoot,'dirty.txt'),'candidate');
  const candidate=await run.review();
  await run.markTested(candidate.candidateHash,true);
  await writeFile(join(original,'dirty.txt'),'foreign');
  await assert.rejects(run.apply(candidate.candidateHash,{confirmed:true}));
  assert.equal(await readFile(join(original,'dirty.txt'),'utf8'),'foreign');
});
```

Extend with case-colliding effects, candidate replacement, altered DACL,
sharing denial and fault after the first effect. A foreign edit during rollback
must survive; unresolved backups produce `blocked-recovery`, not `applied`.

- [ ] **Step 2: Implement native exact publication.**

Require matching tested candidate hash, full baseline, current epoch, purpose-
bound original ref and existing explicit user confirmation. Snapshot pre-images
durably; validate bytes/metadata/identity immediately at each effect. Serialize
publication per original identity, not merely its path spelling. Verify applied
bytes and original metadata after effects. Attempt rollback only when the
current bytes still equal this transaction's own write; preserve foreign edits.
Maintain the existing documented non-atomic multi-file limitation.

- [ ] **Step 3: Execute a Windows GUI protocol journey with a fake model.**

Reuse the existing `local-workcopy` harness provider/agent. Filesystem, sandbox,
Jobs, test process, journal and Apply remain real. The task changes one file in
a Unicode/space-named project, verifies original unchanged, runs a fixed bundled-
Node verification script, reviews Diff, confirms Apply, then verifies original.
Run once from TS and once using built `dist/gui-server.js`.

Run all four AI-process/Permissions combinations. Assert `auto` never changes
the manually selected model or Permissions; `automatic` never supplies the
final Apply confirmation. Cancel project selection preserves current draft and
project. Restore stopped, reject old handles and resume only on explicit click.

- [ ] **Step 4: Run integration verification.**

Run `node --import tsx --test tests/windows-workspace-publication.test.ts
tests/local-project-run.test.ts tests/gui-desktop-journey.test.ts
tests/gui-server-protocol.test.ts` on Windows; root/test TSC and
`npm --prefix gui test` on both platforms. Inspect public frame captures for
private refs, control frames, URLs, account identities or credentials; any leak
fails the test. Do not use a paid provider in these tests.

- [ ] **Step 5: Commit** `feat: complete guarded Windows local GUI workflow`.

### Task 6: Hersteller-CLI-Setup und korrekte Anbieterzustände

**Files:**

- Create: `src/official-cli-host-{macos,windows}.ts`, `gui/src-tauri/src/native_presentation.rs`, `gui/src-tauri/src/platform/windows/trust.rs`, `gui/src-tauri/build_support/packaged_policy_windows.rs`.
- Create/Test: `tests/official-cli-windows.test.ts`, `gui/src-tauri/tests/windows_manufacturer.rs`.
- Modify/Test: `src/{official-cli-host.ts,official-cli-probe.ts,gui-server.ts}`, `gui/src-tauri/src/{manufacturer_cli.rs,lib.rs,native_owner.rs}`, `gui/src-tauri/{Cargo.toml,build.rs}`, `gui/src/official-cli-panel.ts` and focused tests.

**Interfaces:** Keep `OfficialCliProbePort` and existing independent
installed/version/compatible/authenticated/subscription/runnable facts. Closed
native actions remain `Provider::{Codex,Claude,Kimi}` ×
`Action::{Install,Login,OpenExternal}`; no WebView shell strings.

- [ ] **Step 1: Add provenance and login-state regressions.**

```ts
test('ChatGPT login does not itself prove paid GUI execution',()=>{
  assert.deepEqual(projectCodexLoginStatus('Logged in using ChatGPT\n'),{
    authenticated:true,subscription:null,runnableInGui:false,
  });
});
```

Use injected native probe fixtures for missing binary, fake PATH match, valid
signature/wrong publisher, changed binary after validation, unsupported version,
cancelled login and late response. None may run an unverified executable or
publish raw process output. First run new imports/tests red.

- [ ] **Step 2: Separate discovery by platform and verify before execution.**

Mac logic moves unchanged behind the selector. Windows uses known installation
roots and native opened-file identity. Authenticode is checked with WinVerifyTrust
and expected publisher policy, not merely any valid signature. Unsigned artifacts
need a version-bound independently trusted package/hash proof. Unknown origin
returns unknown with a clear reason; never execute PATH to learn its version.
Bind every fixed argv status command to the verified executable identity and a
bounded timeout/output budget. No user identity in the published result.

- [ ] **Step 3: Implement physical Windows handoff without arbitrary execution.**

Windows PREPARE/COMMIT/REVOKE is generation/deadline-bound. Native main-thread
confirmation is required before a provider install/login/terminal handoff.
Resolve system tools through Windows Known Folders; Windows Terminal is optional.
Use fixed native executable/argv or exact official download-page action, never
`Invoke-Expression`, model-authored PowerShell, `curl|bash` or an Admin fallback.
Download-and-run is enabled only for a separately verified pinned artifact;
otherwise show the official manual installation path. A successful handoff says
"opened", not "installed/logged in"; re-probe after user completion.

Add target-only `Win32_Security_WinTrust` and `Win32_Security_Cryptography`
features. Compile a separate `WindowsPackagedTrustPolicy` containing exact
schema version, product version, allowed publisher SPKI SHA-256 and runtime
manifest SHA-256. An absent policy compiles as `None`; malformed policy fails
the build. Never derive the trusted publisher from the same candidate being
verified. `VerifiedWindowsApp` retains the opened image identity and verified
signature/resource evidence. The existing Mac `VerifiedPackagedApp` stays
unchanged; the coordinator uses a private platform-discriminated owner proof,
not invented device/inode fields. Tests reject unsigned, wrong-publisher,
wrong-version, changed-resource and changed-image candidates and show that raw
JSON cannot construct either verified proof. Unit verifier doubles cannot
authorize actual presentations.

Unsigned development apps do not silently acquire setup authority that the
current Mac build lacks. Until an equivalent trusted Windows packaged-app policy
is verified, provider installation/login actions stay disabled with external
manual instructions. Certificate acquisition/export is not part of this task.

- [ ] **Step 4: Preserve model choices and the Codex runtime boundary.**

Do not repin or widen `src/codex-app-server.ts`'s Darwin-ARM64 0.159.1 profile
just to get green Windows states. This task connects official Windows setup and
observations, not a fictional Windows Codex turn adapter. `runnableInGui` stays
false/unknown until a distinct Windows executable/profile/sandbox/Stop proof and
actual provider turn exist. Claude/Kimi remain external as the spec requires.
No automatic API fallback, no account switch and no credential/profile copying.

Run official CLI host/probe/state/protocol/native-action suites plus Windows
native presentation tests. Confirm unknown vs blocked copy remains actionable in
the GUI and selection never falls back to another model. The final acceptance
record names which route actually completed a task, and lists these boundaries.

- [ ] **Step 5: Commit** `feat: add verified Windows manufacturer CLI handoffs`.

### Task 7: Windows-Runtime und NSIS-Installer bündeln

**Files:**

- Create: `scripts/gui-runtime.windows.json`, `gui/src-tauri/tauri.windows.conf.json`, `tests/gui-windows-package.test.ts`.
- Modify/Test: `scripts/{gui.mjs,gui-platform.mjs}`, `gui/src-tauri/src/{engine.rs,lib.rs}`, `gui/src-tauri/tauri.conf.json`, existing package inspection tests.
- Reuse: existing `gui/src-tauri/icons/icon.ico`; if absent, generate from the existing approved application icon, without a new logo design.

**Interfaces:** `stageRuntime()` selects the host platform and produces
`resources/orcode/{node.exe,dist,node_modules,package.json,orcode-platform-host.exe}`
on Windows, plus a build-bound runtime manifest of exact hashes. Mac staging
does not run Windows operations or change to Windows packaging.

- [ ] **Step 1: Pin runtime inputs and package-negative tests.**

```json
{
  "version": "24.22.0",
  "platform": "win32",
  "arch": "x64",
  "archive": "node-v24.22.0-win-x64.zip",
  "archiveSha256": "f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3",
  "nodeSha256": "ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c"
}
```

These values came from the official release index/checksums on 15.10.2026. A
changed version is an explicit pin update and rerun, not "latest" at build time.
Tests reject wrong arch/version/hash, missing helper, Mac `.node` add-ons, missing
runtime resources and any staged real app home or credential file.

- [ ] **Step 2: Stage on Windows, using Windows-installed dependencies.**

Download only the pinned official archive, verify archive hash before extraction
and binary hash after, then verify `process.platform/arch/version` by executing
the verified Node. Run `npm ci --omit=dev` on Windows from the existing lockfile.
Never copy Mac `node_modules`, call `lipo/chmod/du`, or trust a node on PATH.
Build/hash the helper before embedding runtime-manifest hashes in the shell.
Use the pinned Node to load the packaged native keyring addon; missing CRT/DLL
dependencies fail packaging and the fresh-machine gate.

```json
{
  "bundle": {
    "targets": ["nsis"],
    "resources": {"resources/orcode": "orcode"},
    "windows": {
      "webviewInstallMode": {"type": "downloadBootstrapper", "silent": false},
      "nsis": {"installMode": "currentUser"}
    }
  }
}
```

The shown NSIS/WebView2 keys were checked against the installed Tauri schema;
validate the final merged config again after implementation. The Windows config
overrides bundle targets and sets the existing Windows icon; Mac config stays
Mac-only. Build via `npm run gui:package` with platform selection, without an
implicit signing or release step.

- [ ] **Step 3: Verify resource-only cold start and lifecycle-safe upgrade.**

Launch the installed executable from Explorer/Start menu with PATH stripped of
Node, npm, Git Bash and developer tools. Capture `hello -> hello-ack -> status.get
-> chats.list`, not merely window creation. Project chooser handles `Projekt
Grüße 2026`; Cancel preserves state. Upgrade/uninstall retain user chats, runs,
accounts and recovery artifacts. Any running owned worker is stopped before an
update replaces its executable. Missing WebView2 shows the official installer
path; declining does not claim success or alter user data.

- [ ] **Step 4: Verify and commit** `build: package native Windows runtime and NSIS installer`.

Run package tests, actual Windows package build and installed-artefact smoke.
Record SHA-256 of installer, app, helper, Node and runtime manifest. The artefact
is still a development/test installer until Task 8; do not create a release/tag.

### Task 8: Windows-CI und echte Standardbenutzer-Abnahme

**Files:**

- Create: `.github/workflows/windows-gui.yml`, `scripts/check-windows-native.mjs`, `docs/windows-acceptance.md`.
- Modify: `README.md`, `.github/workflows/ci.yml` only for explicit platform suites rather than blanket skips.

**Interfaces:** `check-windows-native.mjs` exits nonzero when required tests are
skipped, unavailable, failed or have no evidence. It emits an account-free JSON
report containing commit, OS build, platform/arch, runtime/artifact hashes,
suite counts and named canary outcomes. Live owner evidence is a separate manual
section, never forged from CI.

- [ ] **Step 1: Add a workflow that cannot publish a release.**

```yaml
name: Windows GUI
on:
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  native:
    runs-on: windows-2025
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.22.0
          cache: npm
      - run: npm ci
      - run: npm --prefix gui ci
      - run: npm run build
      - run: npm --prefix gui test
      - run: npm --prefix gui run build
      - run: cargo build --manifest-path gui/src-tauri/Cargo.toml --locked --bin orcode-platform-host
      - run: cargo test --manifest-path gui/src-tauri/Cargo.toml --locked --lib
      - run: cargo test --manifest-path gui/src-tauri/Cargo.toml --locked --test windows_native
      - run: node scripts/check-windows-native.mjs
      - run: npm run gui:package
      - uses: actions/upload-artifact@v4
        with:
          name: windows-native-development
          path: |
            gui/src-tauri/target/release/bundle/nsis/*.exe
            .artifacts/windows-native/*.json
```

Install/select the Rust MSVC toolchain explicitly if absent; verify >=1.88 and
use Cargo.lock. Keep GitHub token read-only. Do not inject account profiles,
provider keys, signing secrets or custom unapproved remote hosts. Hosted Windows
Server tests are not relabeled as Windows 11 desktop acceptance.

- [ ] **Step 2: Run full account-free platform verification.**

`check-windows-native.mjs` runs root/test TSC, root Core tests, the five Windows
file/journal/isolation/Stop/publication suites, private-channel/owner tests and
source/built GUI journeys. Remove inherited `FORCE_COLOR` from child test env.
Spawn each command directly with bounded logs and require exit 0. Parse TAP
totals and explicit named evidence; a missing suite is a failure. Retain the
existing Mac full-suite/Rust/GUI gates. `npm audit --omit=dev --audit-level=high`
remains a public-release gate; unresolved advisories are listed, not hidden.

- [ ] **Step 3: Test the actual installer on authorized Windows 11 x64.**

Use a real standard-user environment explicitly placed in scope, not an old
Windows machine found in memory. No WSL, Docker, Hyper-V or global Node. Test
install/start, missing/declined WebView2, Unicode project/Cancel, manual model
choice, four policy combinations, real canaries, Stop at every phase, app crash,
recovery, Diff, confirmed Apply, update and uninstall data retention.

Use the account-free provider fixture first. For the final real provider task,
the owner chooses an already authorized account/model and confirms any usage.
There is no paid fallback. Write which provider actually ran; official external
CLI login is not a completed integrated task. If the requested subscription's
GUI adapter is unproved, record that route as blocked; do not call it supported.

- [ ] **Step 4: Review the whole branch, then state the real shipping boundary.**

One fresh independent read-only reviewer checks the complete diff against the
approved spec and this plan, with special attention to native identity, handle
inheritance, path races, epoch fences and secretless frames. Reproduce/fix any
confirmed findings with tests. Update `docs/windows-acceptance.md` with commit,
hashes, actual pass/fail/untested outcomes and remaining provider/signing limits.
Only claim "Windows-ready" if all applicable spec criteria pass on the installed
artefact. A failed AppContainer/NTFS/native-peer gate stops enablement and returns
the concrete finding; it does not authorize weaker isolation.

- [ ] **Step 5: Commit** `ci: verify native Windows desktop delivery` and push the
development branch after verification. No main merge, GitHub release, npm publish
or tag is part of this plan.

## Spec coverage and proof gates

| Approved requirement | Owning task | Required proof |
| --- | --- | --- |
| Native app, no WSL/global Node, NSIS/WebView2 | 1, 7, 8 | Installed standard-user Windows 11 run |
| Private IPC, owner setup and real process ownership | 2, 6 | Native peer/replay/inheritance and crash tests |
| NTFS/DACL, safe journals, recovery and original protection | 3, 5 | Handle-race, foreign-writer and partial-failure tests |
| Actual local/descendant isolation and global Stop | 4 | Real token/access/network/process-tree canaries |
| Manual models, independent controls, Abo-first | 5, 6, 8 | Four policy combinations and named real provider result |
| Truthful CLI setup and provider limitations | 6 | Native confirmation plus verified status, no fake GUI readiness |
| Mac parity, no new infrastructure, no automatic release | All, 8 | Existing gates and development-only CI permissions |

## Primary implementation references

- [Node 24 release index](https://nodejs.org/dist/index.json) and [24.22.0 checksums](https://nodejs.org/dist/v24.22.0/SHASUMS256.txt).
- [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/).
- [Windows process attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).
- [Windows named-pipe peer identity](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid).
- [Windows AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation).
- [Official Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox); manufacturer support is not orcode adapter evidence.

## Plan review

Architecture approved; this implementation plan awaits review. Recommended
execution: Native in this chat, with bounded independent security review and
one whole-branch review. Approval of the plan does not authorize account login,
paid inference, new remote hosts, certificate purchases or public release.
