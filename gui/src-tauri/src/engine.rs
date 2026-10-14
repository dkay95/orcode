//! The sidecar's whole life: where its two halves come from, how it is
//! spawned, and — the part that actually matters — how it is guaranteed to
//! die with the app.
//!
//! Three facts from G0 shape this file, and every one of them was read from
//! a primary source rather than assumed:
//!
//!  1. **A Rust-spawned child is never auto-killed.** We spawn from Rust
//!     deliberately, so one supervisor exclusively owns `Child` from spawn
//!     through reap and the killing is ours to do.
//!  2. **`std::process::Child::kill()` is SIGKILL**, and SIGKILL cannot be
//!     trapped. orcode's own tool children live in their own process groups
//!     (`workspace.ts`), so SIGKILLing the sidecar ORPHANS every running shell
//!     command. The sidecar must therefore be asked first and killed only as a
//!     bound; a raw PID is never retained or signalled after reap.
//!  3. **stdin EOF is the reliable macOS parent-death signal** — there is no
//!     `PR_SET_PDEATHSIG` — and it is one of the protocol's own three
//!     shutdown triggers (`src/gui-protocol.ts`). Every path here ends with
//!     the child's stdin closed, and because the write end is held by this
//!     process alone, even an abort — a Rust panic under `panic = "abort"`,
//!     a force-quit — closes it as the OS reaps our file descriptors.
//!
//! The shutdown sequence is written against a small trait so it can be
//! `cargo test`ed for ORDER without a window, a WebView or a real child.

#[cfg(unix)]
pub use crate::platform::unix::{
    create_native_sidecar_channels, probe_fixed_fd_collision_matrix, NativeSidecarChannels,
};
#[cfg(unix)]
use crate::platform::unix::{pipe_available_bytes, set_nonblocking, write_nonblocking};
#[cfg(windows)]
pub use crate::platform::windows::{create_native_sidecar_channels, NativeSidecarChannels};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/* =========================================================================
 * One process-spawn gate — private descriptors never cross another spawn
 * ====================================================================== */

fn process_spawn_mutex() -> &'static Mutex<()> {
    static PROCESS_SPAWN_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
    PROCESS_SPAWN_MUTEX.get_or_init(|| Mutex::new(()))
}

/// Proof that the caller owns the complete process replacement transaction.
///
/// This guard starts before an old sidecar is stopped and remains live until
/// the successor and both retained private ends are installed. The raw Rust
/// integration launchers use the same gate, so none can inherit the short
/// interval in which a new pipe exists before the child has been spawned.
pub struct ProcessSpawnGuard {
    _guard: MutexGuard<'static, ()>,
}

pub fn acquire_process_spawn_guard() -> ProcessSpawnGuard {
    let guard = process_spawn_mutex()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ProcessSpawnGuard { _guard: guard }
}

pub fn try_acquire_process_spawn_guard() -> Option<ProcessSpawnGuard> {
    match process_spawn_mutex().try_lock() {
        Ok(guard) => Some(ProcessSpawnGuard { _guard: guard }),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(ProcessSpawnGuard {
            _guard: poisoned.into_inner(),
        }),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
}

/* =========================================================================
 * Private native-action/control channels
 * ====================================================================== */

// Deliberately high fixed descriptors: ordinary Node/Python runtime setup may
// legitimately reuse a closed fd 3/4 before fixture code can inspect it. The
// high pair makes immediate EBADF a meaningful inheritance assertion while
// remaining below macOS's conservative default soft limit.
#[cfg(unix)]
pub const NATIVE_ACTION_CHILD_FD: RawFd = 198;
#[cfg(unix)]
pub const NATIVE_CONTROL_CHILD_FD: RawFd = 199;
pub const ACTION_FRAME_TAG: u8 = 0xA1;
pub const CONTROL_FRAME_TAG: u8 = 0xC1;
pub const MAX_PRIVATE_PAYLOAD: usize = 4096;
pub const CONTROL_QUEUE_DEPTH: usize = 1;
pub const CONTROL_WRITE_GRACE: Duration = Duration::from_millis(500);

#[derive(Debug)]
pub enum NativeChannelError {
    Io(std::io::Error),
    WrongDirection { expected: u8, actual: u8 },
    Oversize { length: usize },
    Truncated,
}

impl std::fmt::Display for NativeChannelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "private channel I/O failed: {error}"),
            Self::WrongDirection { expected, actual } => {
                write!(
                    f,
                    "private frame direction {actual:#04x} did not match {expected:#04x}"
                )
            }
            Self::Oversize { length } => write!(f, "private frame length {length} exceeds 4096"),
            Self::Truncated => write!(f, "private frame was truncated"),
        }
    }
}

impl std::error::Error for NativeChannelError {}

impl From<std::io::Error> for NativeChannelError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn read_private_frame<R: Read>(
    reader: &mut R,
    expected_tag: u8,
) -> Result<Vec<u8>, NativeChannelError> {
    let mut header = [0u8; 5];
    if let Err(error) = reader.read_exact(&mut header) {
        return if error.kind() == std::io::ErrorKind::UnexpectedEof {
            Err(NativeChannelError::Truncated)
        } else {
            Err(error.into())
        };
    }
    if header[0] != expected_tag {
        return Err(NativeChannelError::WrongDirection {
            expected: expected_tag,
            actual: header[0],
        });
    }
    let length = u32::from_be_bytes(header[1..5].try_into().expect("four-byte length")) as usize;
    if length > MAX_PRIVATE_PAYLOAD {
        return Err(NativeChannelError::Oversize { length });
    }
    let mut payload = vec![0u8; length];
    if let Err(error) = reader.read_exact(&mut payload) {
        return if error.kind() == std::io::ErrorKind::UnexpectedEof {
            Err(NativeChannelError::Truncated)
        } else {
            Err(error.into())
        };
    }
    Ok(payload)
}

fn private_frame(tag: u8, payload: &[u8]) -> Result<Vec<u8>, ControlPipeError> {
    if payload.len() > MAX_PRIVATE_PAYLOAD {
        return Err(ControlPipeError::Oversize {
            length: payload.len(),
        });
    }
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(tag);
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

pub struct NativeActionReader {
    file: Option<std::fs::File>,
}

impl NativeActionReader {
    #[cfg(unix)]
    pub(crate) fn from_file(file: std::fs::File) -> Self {
        Self { file: Some(file) }
    }

    pub fn read_frame(&mut self) -> Result<Vec<u8>, NativeChannelError> {
        let Some(file) = self.file.as_mut() else {
            return Err(NativeChannelError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "private action channel is closed",
            )));
        };
        match read_private_frame(file, ACTION_FRAME_TAG) {
            Ok(frame) => Ok(frame),
            Err(error) => {
                // A malformed or truncated frame poisons the stream. Drop the
                // read end now so no later bytes can become a permit and a
                // misbehaving child cannot keep writing into an unread pipe.
                self.file.take();
                Err(error)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlPipeError {
    Backlogged,
    Stalled,
    Gone,
    Oversize { length: usize },
    Failed,
}

enum ControlCommand {
    Write(
        Vec<u8>,
        std::sync::mpsc::SyncSender<Result<(), ControlPipeError>>,
    ),
    Close,
}

pub struct ControlWriteReceipt {
    result: std::sync::mpsc::Receiver<Result<(), ControlPipeError>>,
    grace: Duration,
}

impl ControlWriteReceipt {
    pub fn wait(self) -> Result<(), ControlPipeError> {
        match self.result.recv_timeout(self.grace) {
            Ok(result) => result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(ControlPipeError::Stalled),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(ControlPipeError::Gone),
        }
    }
}

pub struct ControlPipeWriter {
    commands: std::sync::mpsc::SyncSender<ControlCommand>,
    closed: bool,
    grace: Duration,
}

impl ControlPipeWriter {
    #[cfg(unix)]
    pub(crate) fn spawn(mut file: std::fs::File) -> Result<Self, NativeChannelError> {
        set_nonblocking(file.as_raw_fd())?;
        let (commands, incoming) = std::sync::mpsc::sync_channel(CONTROL_QUEUE_DEPTH);
        std::thread::spawn(move || {
            while let Ok(command) = incoming.recv() {
                match command {
                    ControlCommand::Write(frame, reply) => {
                        let result = write_nonblocking(&mut file, &frame, CONTROL_WRITE_GRACE);
                        let _ = reply.try_send(result);
                    }
                    ControlCommand::Close => break,
                }
            }
        });
        Ok(Self {
            commands,
            closed: false,
            grace: CONTROL_WRITE_GRACE,
        })
    }

    pub fn try_enqueue_frame(
        &mut self,
        bytes: &[u8],
    ) -> Result<ControlWriteReceipt, ControlPipeError> {
        if self.closed {
            return Err(ControlPipeError::Gone);
        }
        let frame = private_frame(CONTROL_FRAME_TAG, bytes)?;
        let (reply, result) = std::sync::mpsc::sync_channel(1);
        match self.commands.try_send(ControlCommand::Write(frame, reply)) {
            Ok(()) => {}
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                return Err(ControlPipeError::Backlogged)
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                self.closed = true;
                return Err(ControlPipeError::Gone);
            }
        }
        Ok(ControlWriteReceipt {
            result,
            grace: self.grace,
        })
    }

    pub fn write_frame(&mut self, bytes: &[u8]) -> Result<(), ControlPipeError> {
        self.try_enqueue_frame(bytes)?.wait()
    }
}

impl Drop for ControlPipeWriter {
    fn drop(&mut self) {
        self.closed = true;
        let _ = self.commands.try_send(ControlCommand::Close);
    }
}

#[derive(Debug)]
pub struct CollisionProbe {
    pub case: &'static str,
    pub safe: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopKimiPrivateChannelStatus {
    CandidateReady,
    Unavailable { reason: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopNativeActionCapability {
    Proven,
    Unavailable { reason: &'static str },
}

/// Descriptor/lifecycle proof is only a candidate for Task 5's packaged
/// attestation. It is intentionally not a public provider-ready signal.
pub fn desktop_kimi_private_channel_status() -> DesktopKimiPrivateChannelStatus {
    if cfg!(unix) {
        DesktopKimiPrivateChannelStatus::CandidateReady
    } else {
        DesktopKimiPrivateChannelStatus::Unavailable {
            reason: "native-local-action-unavailable",
        }
    }
}

pub fn desktop_native_action_capability() -> DesktopNativeActionCapability {
    match crate::packaged_app_trust::verify_without_policy() {
        Ok(_) => DesktopNativeActionCapability::Proven,
        Err(_) => DesktopNativeActionCapability::Unavailable {
            reason: "native-local-action-unavailable",
        },
    }
}

/// The line the shell writes before it stops reading.
///
/// The same request a client sends over the protocol; it is best-effort by
/// design — a sidecar that never handshook refuses it, and the EOF that
/// follows is what actually ends that one.
pub const SHUTDOWN_REQUEST: &str =
    r#"{"v":1,"t":"shutdown","id":"shell-exit","reason":"app-exit"}"#;

/// How long a sidecar gets to end itself before the shell reaches for SIGKILL.
///
/// Measured, not guessed. A healthy engine with a populated app home took
/// 2.6 s and 5.2 s to exit after EOF on this machine (G2, 2026-08-30) — the
/// spread is its own teardown work, not the pipe — and its `SHUTDOWN_DRAIN_MS`
/// (5 s, `gui-server.ts`) applies on top of that when a run has to be
/// cancelled first. The bound therefore sits well above the worst reading:
/// killing an engine that was about to save is exactly the
/// orphan-the-tool-children-and-lose-the-partial outcome the drain exists to
/// prevent, and a slow quit is the cheaper of the two mistakes.
pub const SHUTDOWN_GRACE: Duration = Duration::from_millis(10_000);

/// How often the grace window is checked. Small enough that an ordinary exit
/// (G1 measured 16 ms for the EOF path) costs one poll, not a fixed wait.
pub const SHUTDOWN_POLL: Duration = Duration::from_millis(25);

/* =========================================================================
 * Resolution — which node, which script, whose home
 * ====================================================================== */

/// Where a launch's four facts came from, so the UI can say them out loud
/// instead of the owner guessing why the engine did not start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineLaunch {
    pub node: PathBuf,
    pub script: PathBuf,
    pub cwd: PathBuf,
    pub home: PathBuf,
    /// False means the dev fixture home — the default everywhere but a
    /// deliberate `--real-home`.
    pub real_home: bool,
}

/// Names the missing half, never "something went wrong".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    NodeMissing { looked_in: Vec<String> },
    ScriptMissing { looked_in: Vec<String> },
    Spawn(String),
    NotRunning,
    Io(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // The wording is the shell's own — it describes the SHELL's
            // failure to start an engine, which is not a truth the engine
            // could have sent, because there is no engine yet.
            Self::NodeMissing { looked_in } => write!(
                f,
                "No Node.js runtime was found. Looked in: {}. Set ORCODE_GUI_NODE to the node binary to use.",
                looked_in.join(", ")
            ),
            Self::ScriptMissing { looked_in } => write!(
                f,
                "The engine script (dist/gui-server.js) was not found. Looked in: {}. Run `npm run build` in the orcode repo, or set ORCODE_GUI_SERVER.",
                looked_in.join(", ")
            ),
            Self::Spawn(message) => write!(f, "The engine could not be started: {message}"),
            Self::NotRunning => write!(f, "No engine is running."),
            Self::Io(message) => write!(f, "The engine connection failed: {message}"),
        }
    }
}

/// The node binaries a GUI launched from Finder can actually find.
///
/// A double-clicked `.app` inherits launchd's minimal `PATH`, not the shell's
/// (G0 §1.3), so PATH alone is not enough. A PACKAGED app carries its own node
/// and never gets this far; these are what a DEV build (`npm run gui:build`,
/// no staged runtime) falls back to, and what a packaged app would fall back
/// to if its own runtime were somehow missing.
#[cfg(unix)]
pub const NODE_FALLBACKS: &[&str] = &[
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/opt/local/bin/node",
];

#[cfg(windows)]
pub const NODE_FALLBACKS: &[&str] = &[];

/// Resolves the node binary: an explicit override, then the BUNDLED runtime,
/// then `PATH`, then the well-known locations. `exists` is injected so the
/// order is testable.
///
/// The bundled copy outranks `PATH` deliberately, and that order is the whole
/// point of shipping one: a packaged app must run the runtime it was tested
/// with, not whichever node happens to be first on the machine it lands on —
/// which may be years older than the engine's own syntax. The override still
/// wins over both, because a developer pointing at a specific binary is
/// stating a fact about their own machine.
pub fn resolve_node(
    explicit: Option<&str>,
    bundled: Option<&Path>,
    path_var: Option<&str>,
    fallbacks: &[&str],
    exists: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, EngineError> {
    let mut looked_in: Vec<String> = Vec::new();
    if let Some(explicit) = explicit.filter(|value| !value.trim().is_empty()) {
        let candidate = PathBuf::from(explicit);
        if exists(&candidate) {
            return Ok(candidate);
        }
        looked_in.push(format!("ORCODE_GUI_NODE={explicit}"));
    }
    if let Some(bundled) = bundled {
        if exists(bundled) {
            return Ok(bundled.to_path_buf());
        }
        looked_in.push(bundled.display().to_string());
    }
    for entry in std::env::split_paths(path_var.unwrap_or_default())
        .filter(|entry| !entry.as_os_str().is_empty())
    {
        let candidate = entry.join(crate::platform::NODE_BINARY_NAME);
        if exists(&candidate) {
            return Ok(candidate);
        }
    }
    for fallback in fallbacks {
        let candidate = PathBuf::from(fallback);
        if exists(&candidate) {
            return Ok(candidate);
        }
        looked_in.push((*fallback).to_string());
    }
    Err(EngineError::NodeMissing { looked_in })
}

/// Resolves `dist/gui-server.js`: an explicit override, then the bundled
/// resource copy, then the repo checkout this binary was compiled in.
pub fn resolve_script(
    explicit: Option<&str>,
    candidates: &[PathBuf],
    exists: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, EngineError> {
    let mut looked_in: Vec<String> = Vec::new();
    if let Some(explicit) = explicit.filter(|value| !value.trim().is_empty()) {
        let candidate = PathBuf::from(explicit);
        if exists(&candidate) {
            return Ok(candidate);
        }
        looked_in.push(format!("ORCODE_GUI_SERVER={explicit}"));
    }
    for candidate in candidates {
        if exists(candidate) {
            return Ok(candidate.clone());
        }
        looked_in.push(candidate.display().to_string());
    }
    Err(EngineError::ScriptMissing { looked_in })
}

/// Did this engine come out of the app's own bundle?
///
/// The provenance test behind `uses_real_home`, extracted (fix round 1, B-4)
/// so the derivation itself is pinned rather than only the truth table it
/// feeds. `bundled` is the path this app WOULD carry if it were packaged;
/// `resolved` is the one `resolve_script` actually returned. They match only
/// when the engine being launched is the bundle's own — which is a resolved
/// path, not a claim the app makes about itself.
pub fn is_packaged(bundled: Option<&Path>, resolved: &Path) -> bool {
    bundled == Some(resolved)
}

/// Whose app home a launch uses — the one decision that must not be wrong in
/// either direction.
///
/// A DEV build must never touch `~/.orcode`: a half-built GUI on the owner's
/// real chats, config and keys is the hazard the fixture home exists for. A
/// PACKAGED app must never use the fixture: `gui/.devhome` is resolved from
/// `CARGO_MANIFEST_DIR`, a path on the BUILD machine, so a shipped app that
/// defaulted to it would point at a directory that does not exist on the
/// owner's — which is exactly what the first packaged build did.
///
/// "Packaged" is decided by the engine's own provenance: an engine that came
/// out of this bundle's own Resources is a shipped app. Nothing here reads a
/// flag the app itself set, because a flag is a claim and a resolved path is
/// a fact.
pub fn uses_real_home(packaged: bool, opted_in: bool) -> bool {
    packaged || opted_in
}

/* =========================================================================
 * The stderr tail — a CLASSIFICATION, never the text
 * ====================================================================== */

/// How much of the engine's stderr is kept to classify a death by.
///
/// A ring, not a log: the last words before an exit are the ones that say
/// why, and an unbounded buffer on a chatty engine is a memory leak with a
/// crash report inside it.
pub const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// The last bytes the engine wrote to stderr, bounded.
///
/// R-SEC-5, restated because this is the file that could break it: the tail
/// itself NEVER crosses to the WebView. It exists so `classify_exit` can turn
/// it into one word from a closed vocabulary, and that word is all the window
/// is told. The full text stays on this process's own stderr, where it has
/// always gone.
#[derive(Default)]
pub struct StderrTail {
    text: String,
}

impl StderrTail {
    pub fn push(&mut self, chunk: &str) {
        self.text.push_str(chunk);
        if self.text.len() > STDERR_TAIL_BYTES {
            // Keep the TAIL: the sentence that ends a process is the one that
            // explains it. Cut on a char boundary so the classifier never sees
            // a mangled codepoint.
            let cut = self.text.len() - STDERR_TAIL_BYTES;
            let boundary = (cut..self.text.len())
                .find(|index| self.text.is_char_boundary(*index))
                .unwrap_or(self.text.len());
            self.text.drain(..boundary);
        }
    }

    pub fn classify(&self) -> Option<&'static str> {
        classify_exit(&self.text)
    }
}

/// The closed vocabulary of causes this shell will name.
///
/// Every entry is a shape a node process actually dies in before it can speak
/// the protocol — the exact case G2 concern 4 left open ("an engine that dies
/// before `hello` shows an exit code and no reason in the window"). The window
/// turns the code into its own sentence; nothing from the engine's own bytes
/// travels with it, so a hostile or merely noisy stderr cannot write on an
/// owner's screen.
pub const EXIT_CAUSES: &[&str] = &[
    "engine-module-missing",
    "engine-node-too-old",
    "engine-syntax",
    "engine-permission",
    "engine-out-of-memory",
    "engine-port-in-use",
    "engine-crashed",
];

pub fn classify_exit(tail: &str) -> Option<&'static str> {
    // Ordered most-specific first: a `SyntaxError` raised by an old node
    // parsing modern syntax is a version problem, not a source problem, and
    // the version marker is the one that must win.
    if tail.contains("ERR_MODULE_NOT_FOUND")
        || tail.contains("Cannot find module")
        || tail.contains("Cannot find package")
    {
        return Some("engine-module-missing");
    }
    if tail.contains("Unsupported engine")
        || tail.contains("requires Node.js version")
        || tail.contains("ERR_UNSUPPORTED_NODE_VERSION")
        // Node < 14 cannot parse optional chaining or `??`; both land as this.
        || tail.contains("SyntaxError: Unexpected token '?'")
        || tail.contains("SyntaxError: Unexpected token '.'")
        || tail.contains("Unexpected token '?'")
    {
        return Some("engine-node-too-old");
    }
    if tail.contains("SyntaxError") {
        return Some("engine-syntax");
    }
    if tail.contains("EACCES") || tail.contains("EPERM") || tail.contains("Operation not permitted")
    {
        return Some("engine-permission");
    }
    if tail.contains("JavaScript heap out of memory") || tail.contains("ERR_WORKER_OUT_OF_MEMORY") {
        return Some("engine-out-of-memory");
    }
    if tail.contains("EADDRINUSE") {
        return Some("engine-port-in-use");
    }
    // The generic last resort, and it must stay NARROW — this is the one
    // classifier a non-crash could trip.
    //
    // Fix round 1 (B-1): `Error: ` on its own was far too loose. The engine's
    // own honest diagnostics write it in normal life — `gui-server.ts` logs
    // `orcode-gui: run failed: <safeMessage>` for any mid-session provider
    // failure — and the R1 stdout guard reroutes stray, model-influenced
    // stdout here too. Either would have made a later death read as an
    // unhandled crash. What actually distinguishes a node process dying on an
    // uncaught throw is the STACK it prints with it, so the pair is required:
    // a thrown error AND a frame under it. A log line has no frames.
    let has_stack_frame = tail.contains("\n    at ") || tail.starts_with("    at ");
    if tail.contains("UnhandledPromiseRejection")
        || tail.contains("ERR_UNHANDLED_REJECTION")
        || tail.contains("throw er;")
        || (tail.contains("Error: ") && has_stack_frame)
    {
        return Some("engine-crashed");
    }
    None
}

/* =========================================================================
 * The pipe — bounded, and never on the caller's thread
 * ====================================================================== */

/// How long any one pipe operation may hold its caller.
///
/// F5(a), the edge G2 measured and left: `child.write` blocks once the
/// kernel's stdin buffer is full (65,536 bytes on this machine, measured
/// against a real non-reading child), and a wedged engine that stopped
/// reading would then block the caller — including the quit, before the
/// bounded wait it is supposed to be bounded by, even starts.
pub const PIPE_GRACE: Duration = Duration::from_millis(500);

/// How many unwritten lines may queue before a write is REFUSED.
///
/// The cooperative half of the drain: an engine that is not reading gets a
/// bounded backlog and then honest refusals, instead of a queue that grows
/// until it is the memory problem. Sized well under the 64 KiB the kernel
/// buffers, so the refusal arrives before the block would.
pub const PIPE_QUEUE_DEPTH: usize = 32;

/// What a pipe operation can go wrong as. Codes, not operating-system text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipeError {
    /// The engine stopped reading and the backlog is full.
    Backlogged,
    /// The write did not complete inside `PIPE_GRACE`.
    Stalled,
    /// There is no pipe any more.
    Gone,
    Failed(String),
}

/// The one thing the pipe thread needs of a child: a line in, a result out.
pub trait PipeSink: Send + 'static {
    fn write_line(&mut self, line: &str) -> Result<(), String>;
}

/// Every command carries the ticket its acknowledgement will come back on.
///
/// Fix round 1 (B-2): without the ticket, a `Stalled` write leaves its late
/// ack in the queue and the NEXT call consumes it — reporting a line
/// delivered while it is still sitting in the queue, or blaming one line for
/// another's failure. `close()` was worse: `matches!(…, Ok(_))` counted ANY
/// stale ack, including a failed write's, as the EOF acknowledgement. The
/// misreport is only reachable after a stall — which is precisely the
/// degraded state this whole mechanism exists to be honest about.
enum PipeCommand {
    Write(u64, String),
    Close(u64),
}

/// One acknowledgement, and the ticket it answers.
struct PipeAck {
    seq: u64,
    result: Result<(), String>,
}

/// A child's stdin, owned by a thread of its own.
///
/// Nothing that calls this ever blocks for longer than `PIPE_GRACE`: the
/// queue is bounded and non-blocking to push, and every caller waits on an
/// acknowledgement with a deadline. A write that wedges therefore costs one
/// refused request, never a frozen window and never a quit that outlives its
/// own grace bound.
pub struct ChildPipe {
    commands: std::sync::mpsc::SyncSender<PipeCommand>,
    acks: std::sync::mpsc::Receiver<PipeAck>,
    grace: Duration,
    /// The next ticket. Monotonic, never reused.
    seq: u64,
    closed: bool,
}

impl ChildPipe {
    pub fn spawn<S: PipeSink>(sink: S) -> Self {
        Self::spawn_with(sink, PIPE_GRACE, PIPE_QUEUE_DEPTH)
    }

    /// The bounds as parameters, so a test can drive the wedged case in
    /// milliseconds instead of waiting out the shipped ones.
    pub fn spawn_with<S: PipeSink>(mut sink: S, grace: Duration, depth: usize) -> Self {
        let (commands, incoming) = std::sync::mpsc::sync_channel::<PipeCommand>(depth);
        // Deep enough that a thread finishing a stalled write can always put
        // its late ack down and move on: a full ack channel would block the
        // very thread the bound exists to keep moving.
        let (outgoing, acks) = std::sync::mpsc::sync_channel::<PipeAck>(depth * 2 + 2);
        std::thread::spawn(move || {
            for command in incoming {
                match command {
                    PipeCommand::Write(seq, line) => {
                        let result = sink.write_line(&line);
                        if outgoing.send(PipeAck { seq, result }).is_err() {
                            // Nobody is waiting any more; the child is dropped
                            // when this thread ends, which IS the EOF.
                            break;
                        }
                    }
                    PipeCommand::Close(seq) => {
                        let _ = outgoing.send(PipeAck {
                            seq,
                            result: Ok(()),
                        });
                        break;
                    }
                }
            }
            // Dropping `sink` drops the child, and dropping the child drops
            // the `PipeWriter` it holds. That is the EOF, on every exit from
            // this loop — including a panicking one.
            drop(sink);
        });
        Self {
            commands,
            acks,
            grace,
            seq: 0,
            closed: false,
        }
    }

    fn ticket(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// Waits for the acknowledgement of ONE ticket, inside one shared bound.
    ///
    /// Acks for older tickets are discarded as they arrive — they belong to
    /// calls that already answered `Stalled`, and answering a new call with an
    /// old one is the whole defect. The deadline is computed once, so draining
    /// them can never extend a caller's wait past the grace window.
    fn await_ack(&mut self, seq: u64) -> Result<(), PipeError> {
        let deadline = std::time::Instant::now() + self.grace;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            match self.acks.recv_timeout(remaining) {
                Ok(ack) if ack.seq == seq => {
                    return ack.result.map_err(PipeError::Failed);
                }
                // A late ack for a call that already gave up. Drop it.
                Ok(_) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Err(PipeError::Stalled),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    self.closed = true;
                    return Err(PipeError::Gone);
                }
            }
        }
    }

    pub fn write(&mut self, line: &str) -> Result<(), PipeError> {
        if self.closed {
            return Err(PipeError::Gone);
        }
        let seq = self.ticket();
        match self
            .commands
            .try_send(PipeCommand::Write(seq, line.to_string()))
        {
            Ok(()) => {}
            Err(std::sync::mpsc::TrySendError::Full(_)) => return Err(PipeError::Backlogged),
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                self.closed = true;
                return Err(PipeError::Gone);
            }
        }
        self.await_ack(seq)
    }

    /// Asks the pipe thread to drop the child, bounded like everything else.
    ///
    /// Returns whether the EOF was acknowledged. A `false` is not a failure to
    /// close: the thread still owns the child, so the fd closes when this
    /// process does — it is a failure to close *promptly*, and the caller says
    /// so out loud rather than pretending the polite path worked.
    pub fn close(&mut self) -> bool {
        if self.closed {
            return true;
        }
        self.closed = true;
        let seq = self.ticket();
        // A full queue means a wedged write is already holding the thread; the
        // drop still happens, just not on our schedule.
        if self.commands.try_send(PipeCommand::Close(seq)).is_err() {
            return false;
        }
        // Only THIS ticket's ack counts as the EOF. A stalled write's late ack
        // is not an acknowledgement that stdin closed, and a failed write's is
        // not one either.
        self.await_ack(seq).is_ok()
    }
}

/* =========================================================================
 * One generation/lifecycle state and atomic generation-bound publication
 * ====================================================================== */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecyclePhase {
    Empty,
    Starting,
    Live,
    Stopping,
}

#[derive(Debug, Clone)]
pub struct SidecarLifecycleState<L, P, C> {
    pub generation: u64,
    pub phase: LifecyclePhase,
    pub live: Option<L>,
    pub public_channel: Option<P>,
    pub control_writer: Option<C>,
}

pub struct LifecycleStore<L, P, C> {
    state: Mutex<SidecarLifecycleState<L, P, C>>,
}

impl<L, P, C> Default for LifecycleStore<L, P, C> {
    fn default() -> Self {
        Self::new()
    }
}

impl<L, P, C> LifecycleStore<L, P, C> {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(SidecarLifecycleState {
                generation: 0,
                phase: LifecyclePhase::Empty,
                live: None,
                public_channel: None,
                control_writer: None,
            }),
        }
    }

    pub fn phase(&self) -> LifecyclePhase {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).phase
    }

    /// Begins a fresh generation under the global spawn guard. Revocation of
    /// the old control/public sinks is in the same state-lock transaction.
    pub fn begin_start(&self, _guard: &ProcessSpawnGuard) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.phase = LifecyclePhase::Starting;
        state.live = None;
        state.public_channel = None;
        state.control_writer = None;
        state.generation
    }

    pub fn install_live(
        &self,
        _guard: &ProcessSpawnGuard,
        generation: u64,
        live: L,
        public_channel: P,
        control_writer: C,
    ) -> Result<(), ()> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.generation != generation || state.phase != LifecyclePhase::Starting {
            return Err(());
        }
        state.live = Some(live);
        state.public_channel = Some(public_channel);
        state.control_writer = Some(control_writer);
        state.phase = LifecyclePhase::Live;
        Ok(())
    }

    pub fn take_live_for_stop(&self, _guard: &ProcessSpawnGuard) -> Option<L> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.phase = LifecyclePhase::Stopping;
        state.public_channel = None;
        state.control_writer = None;
        state.live.take()
    }

    /// Panic-hook variant: never waits on a lifecycle lock the panicking
    /// thread may itself hold.
    pub fn try_take_live_for_stop(&self, _guard: &ProcessSpawnGuard) -> Result<Option<L>, ()> {
        let mut state = match self.state.try_lock() {
            Ok(state) => state,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return Err(()),
        };
        state.phase = LifecyclePhase::Stopping;
        state.public_channel = None;
        state.control_writer = None;
        Ok(state.live.take())
    }

    pub fn finish_stop(&self, _guard: &ProcessSpawnGuard) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.phase = LifecyclePhase::Empty;
        state.live = None;
        state.public_channel = None;
        state.control_writer = None;
    }

    pub fn restore_stopping(&self, _guard: &ProcessSpawnGuard, live: L) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.phase = LifecyclePhase::Stopping;
        state.live = Some(live);
        state.public_channel = None;
        state.control_writer = None;
    }

    pub fn with_live<R>(&self, callback: impl FnOnce(Option<&mut L>, LifecyclePhase) -> R) -> R {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let phase = state.phase;
        callback(state.live.as_mut(), phase)
    }

    /// Generation compare and public send share this lock. A restart can
    /// happen before or after the call, never between compare and publish.
    pub fn with_current_public<R>(
        &self,
        generation: u64,
        callback: impl FnOnce(&mut P) -> R,
    ) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.generation != generation || state.phase != LifecyclePhase::Live {
            return false;
        }
        let Some(channel) = state.public_channel.as_mut() else {
            return false;
        };
        callback(channel);
        true
    }

    /// The same atomic compare-and-enqueue rule for native dialog callbacks.
    pub fn with_current_control<R>(
        &self,
        generation: u64,
        callback: impl FnOnce(&mut C) -> R,
    ) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.generation != generation || state.phase != LifecyclePhase::Live {
            return false;
        }
        let Some(writer) = state.control_writer.as_mut() else {
            return false;
        };
        callback(writer);
        true
    }

    /// Publishes the terminal event and revokes every handle for exactly one
    /// current generation in one state-lock transaction. A successor can
    /// therefore observe either the live predecessor or the fully empty,
    /// invalidated state, never an Exited event with writable old channels.
    pub fn terminate_current<R>(
        &self,
        generation: u64,
        callback: impl FnOnce(&mut P) -> R,
    ) -> Option<L> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.generation != generation || state.phase != LifecyclePhase::Live {
            return None;
        }
        let channel = state.public_channel.as_mut()?;
        callback(channel);
        state.generation = state.generation.wrapping_add(1);
        state.phase = LifecyclePhase::Empty;
        state.public_channel = None;
        state.control_writer = None;
        state.live.take()
    }

    pub fn generation(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .generation
    }
}

impl<L: Clone, P: Clone, C: Clone> LifecycleStore<L, P, C> {
    pub fn snapshot_clone(&self) -> SidecarLifecycleState<L, P, C> {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl<L, P> LifecycleStore<L, P, ControlPipeWriter> {
    /// Generation comparison and the bounded-queue enqueue are atomic. The
    /// potentially 500 ms pipe acknowledgement belongs to the returned
    /// receipt and is deliberately waited outside the lifecycle mutex.
    pub fn enqueue_current_control(
        &self,
        generation: u64,
        bytes: &[u8],
    ) -> Result<ControlWriteReceipt, ControlPipeError> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.generation != generation || state.phase != LifecyclePhase::Live {
            return Err(ControlPipeError::Gone);
        }
        state
            .control_writer
            .as_mut()
            .ok_or(ControlPipeError::Gone)?
            .try_enqueue_frame(bytes)
    }
}

/* =========================================================================
 * Raw child ownership and capacity-one event drain
 * ====================================================================== */

pub const RAW_EVENT_CAPACITY: usize = 1;
const RAW_SEND_POLL: Duration = Duration::from_millis(2);
const RAW_OWNER_POLL: Duration = Duration::from_millis(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawEngineEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Error,
    Terminated {
        code: Option<i32>,
        signal: Option<i32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForceKillResult {
    Signalled,
    AlreadyExited,
}

#[derive(Debug, Clone, Copy)]
struct ExitRecord {
    code: Option<i32>,
    signal: Option<i32>,
}

#[derive(Default)]
struct ExitState {
    record: Option<ExitRecord>,
}

enum OwnerCommand {
    Kill(std::sync::mpsc::SyncSender<Result<ForceKillResult, String>>),
}

#[derive(Clone)]
pub struct RawProcessOwnership {
    commands: std::sync::mpsc::SyncSender<OwnerCommand>,
    exit: Arc<(Mutex<ExitState>, Condvar)>,
}

impl RawProcessOwnership {
    fn spawn(mut child: std::process::Child) -> Self {
        let (commands, incoming) = std::sync::mpsc::sync_channel::<OwnerCommand>(1);
        let exit = Arc::new((Mutex::new(ExitState::default()), Condvar::new()));
        let exit_for_thread = Arc::clone(&exit);
        std::thread::spawn(move || loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let record = ExitRecord {
                        code: status.code(),
                        signal: crate::platform::exit_signal(&status),
                    };
                    let (lock, changed) = &*exit_for_thread;
                    lock.lock().unwrap_or_else(|p| p.into_inner()).record = Some(record);
                    changed.notify_all();
                    break;
                }
                Ok(None) => {}
                Err(_) => {
                    // Ownership never falls back to a raw PID. On an
                    // unexpected wait error this same thread still closes the
                    // process with its Child handle and attempts the reap.
                    let _ = child.kill();
                    let status = child.wait().ok();
                    let (lock, changed) = &*exit_for_thread;
                    lock.lock().unwrap_or_else(|p| p.into_inner()).record = Some(ExitRecord {
                        code: status.as_ref().and_then(std::process::ExitStatus::code),
                        signal: status.as_ref().and_then(crate::platform::exit_signal),
                    });
                    changed.notify_all();
                    break;
                }
            }
            match incoming.try_recv() {
                Ok(OwnerCommand::Kill(reply)) => {
                    // The exclusive owner rechecks immediately before kill.
                    // `Child` and PID never leave this thread, so a reaped PID
                    // cannot be signalled after reuse.
                    let result = match child.try_wait() {
                        Ok(Some(status)) => {
                            let record = ExitRecord {
                                code: status.code(),
                                signal: crate::platform::exit_signal(&status),
                            };
                            let (lock, changed) = &*exit_for_thread;
                            lock.lock().unwrap_or_else(|p| p.into_inner()).record = Some(record);
                            changed.notify_all();
                            Ok(ForceKillResult::AlreadyExited)
                        }
                        Ok(None) => child
                            .kill()
                            .map(|_| ForceKillResult::Signalled)
                            .map_err(|e| e.to_string()),
                        Err(error) => Err(error.to_string()),
                    };
                    let already = matches!(result, Ok(ForceKillResult::AlreadyExited));
                    let _ = reply.send(result);
                    if already {
                        break;
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {}
            }
            std::thread::sleep(RAW_OWNER_POLL);
        });
        Self { commands, exit }
    }

    fn exit_record(&self) -> Option<ExitRecord> {
        self.exit.0.lock().unwrap_or_else(|p| p.into_inner()).record
    }

    pub fn is_alive(&self) -> bool {
        self.exit_record().is_none()
    }

    fn wait_exit(&self) -> ExitRecord {
        let (lock, changed) = &*self.exit;
        let mut state = lock.lock().unwrap_or_else(|p| p.into_inner());
        while state.record.is_none() {
            state = changed.wait(state).unwrap_or_else(|p| p.into_inner());
        }
        state.record.expect("exit record set before notification")
    }

    pub fn wait_reaped(&self, bound: Duration) -> bool {
        let deadline = Instant::now() + bound;
        let (lock, changed) = &*self.exit;
        let mut state = lock.lock().unwrap_or_else(|p| p.into_inner());
        while state.record.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            let waited = changed
                .wait_timeout(state, left)
                .unwrap_or_else(|p| p.into_inner());
            state = waited.0;
            if waited.1.timed_out() && state.record.is_none() {
                return false;
            }
        }
        true
    }

    pub fn force_kill(&self, bound: Duration) -> Result<ForceKillResult, String> {
        if self.exit_record().is_some() {
            return Ok(ForceKillResult::AlreadyExited);
        }
        let (reply, answer) = std::sync::mpsc::sync_channel(1);
        self.commands
            .try_send(OwnerCommand::Kill(reply))
            .map_err(|_| "owner unavailable".to_string())?;
        answer
            .recv_timeout(bound)
            .map_err(|_| "kill acknowledgement timed out".to_string())?
    }
}

#[derive(Clone)]
pub struct GenerationDrain {
    cancel: Arc<std::sync::atomic::AtomicBool>,
    completion: Arc<(Mutex<DrainCompletion>, Condvar)>,
}

#[derive(Default)]
struct DrainCompletion {
    producers_done: bool,
    consumer_done: bool,
}

impl GenerationDrain {
    pub fn revoke(&self) {
        self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn wait(&self, bound: Duration) -> bool {
        let deadline = Instant::now() + bound;
        let (lock, changed) = &*self.completion;
        let mut completion = lock.lock().unwrap_or_else(|p| p.into_inner());
        while !(completion.producers_done && completion.consumer_done) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            let waited = changed
                .wait_timeout(completion, left)
                .unwrap_or_else(|p| p.into_inner());
            completion = waited.0;
            if waited.1.timed_out() && !(completion.producers_done && completion.consumer_done) {
                return false;
            }
        }
        true
    }
}

fn send_raw_cancellable(
    sender: &std::sync::mpsc::SyncSender<RawEngineEvent>,
    mut event: RawEngineEvent,
    cancel: &std::sync::atomic::AtomicBool,
) -> bool {
    loop {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        match sender.try_send(event) {
            Ok(()) => return true,
            Err(std::sync::mpsc::TrySendError::Full(returned)) => {
                event = returned;
                std::thread::sleep(RAW_SEND_POLL);
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => return false,
        }
    }
}

#[cfg(unix)]
fn spawn_reader<R: Read + AsRawFd + Send + 'static>(
    mut reader: R,
    stderr: bool,
    sender: std::sync::mpsc::SyncSender<RawEngineEvent>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    owner_reaped: Arc<std::sync::atomic::AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        enum ReapDrain {
            BeforeReap,
            Quota(usize),
            SnapshotFailed,
        }
        let mut buffer = vec![0u8; 4096];
        let mut reap_drain = ReapDrain::BeforeReap;
        loop {
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            if matches!(&reap_drain, ReapDrain::BeforeReap)
                && owner_reaped.load(std::sync::atomic::Ordering::SeqCst)
            {
                reap_drain = match pipe_available_bytes(reader.as_raw_fd()) {
                    Ok(available) => ReapDrain::Quota(available),
                    Err(_) => {
                        // A zero quota on ioctl failure would silently discard
                        // parent bytes. Publish the pipe failure and preserve
                        // bytes by falling back to EOF/cancellation semantics.
                        if !send_raw_cancellable(&sender, RawEngineEvent::Error, &cancel) {
                            break;
                        }
                        ReapDrain::SnapshotFailed
                    }
                };
            }
            let read_limit = match &reap_drain {
                ReapDrain::Quota(0) => break,
                ReapDrain::Quota(remaining) => (*remaining).min(buffer.len()),
                ReapDrain::BeforeReap | ReapDrain::SnapshotFailed => buffer.len(),
            };
            match reader.read(&mut buffer[..read_limit]) {
                Ok(0) => {
                    if matches!(&reap_drain, ReapDrain::Quota(remaining) if *remaining > 0) {
                        let _ = send_raw_cancellable(&sender, RawEngineEvent::Error, &cancel);
                    }
                    break;
                }
                Ok(count) => {
                    if let ReapDrain::Quota(remaining) = &mut reap_drain {
                        *remaining -= count;
                    }
                    let bytes = buffer[..count].to_vec();
                    let event = if stderr {
                        RawEngineEvent::Stderr(bytes)
                    } else {
                        RawEngineEvent::Stdout(bytes)
                    };
                    if !send_raw_cancellable(&sender, event, &cancel) {
                        break;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(RAW_SEND_POLL);
                }
                Err(_) => {
                    let _ = send_raw_cancellable(&sender, RawEngineEvent::Error, &cancel);
                    break;
                }
            }
        }
    })
}

struct ChildStdin(std::process::ChildStdin);

impl PipeSink for ChildStdin {
    fn write_line(&mut self, line: &str) -> Result<(), String> {
        self.0
            .write_all(line.as_bytes())
            .and_then(|_| self.0.write_all(b"\n"))
            .and_then(|_| self.0.flush())
            .map_err(|error| error.to_string())
    }
}

pub struct RawEngine {
    pid: u32,
    pipe: Option<ChildPipe>,
    receiver: Option<RawEventReceiver>,
    ownership: RawProcessOwnership,
    drain: GenerationDrain,
    detached: bool,
}

pub fn spawn_raw_engine(
    _guard: &ProcessSpawnGuard,
    command: Command,
) -> Result<RawEngine, EngineError> {
    spawn_raw_engine_after(_guard, command, || {})
}

#[cfg(unix)]
pub fn spawn_raw_engine_after<F: FnOnce()>(
    _guard: &ProcessSpawnGuard,
    mut command: Command,
    after_spawn: F,
) -> Result<RawEngine, EngineError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| EngineError::Spawn(error.to_string()))?;
    // The private-channel caller closes both child ends at this exact
    // boundary, before reader and supervisor construction does any work.
    after_spawn();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| EngineError::Spawn("child stdin missing".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| EngineError::Spawn("child stdout missing".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| EngineError::Spawn("child stderr missing".into()))?;
    if let Err(error) =
        set_nonblocking(stdout.as_raw_fd()).and_then(|_| set_nonblocking(stderr.as_raw_fd()))
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(EngineError::Spawn(error.to_string()));
    }
    let pid = child.id();
    let ownership = RawProcessOwnership::spawn(child);
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let completion = Arc::new((Mutex::new(DrainCompletion::default()), Condvar::new()));
    let drain = GenerationDrain {
        cancel: Arc::clone(&cancel),
        completion: Arc::clone(&completion),
    };
    let (sender, raw_receiver) = std::sync::mpsc::sync_channel(RAW_EVENT_CAPACITY);
    let receiver = RawEventReceiver {
        receiver: raw_receiver,
        cancel: Arc::clone(&cancel),
        completion: Arc::clone(&completion),
    };
    let owner_reaped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stdout_thread = spawn_reader(
        stdout,
        false,
        sender.clone(),
        Arc::clone(&cancel),
        Arc::clone(&owner_reaped),
    );
    let stderr_thread = spawn_reader(
        stderr,
        true,
        sender.clone(),
        Arc::clone(&cancel),
        Arc::clone(&owner_reaped),
    );
    let owner_for_drain = ownership.clone();
    std::thread::spawn(move || {
        let record = owner_for_drain.wait_exit();
        owner_reaped.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        let _ = send_raw_cancellable(
            &sender,
            RawEngineEvent::Terminated {
                code: record.code,
                signal: record.signal,
            },
            &cancel,
        );
        let (lock, changed) = &*completion;
        lock.lock()
            .unwrap_or_else(|p| p.into_inner())
            .producers_done = true;
        changed.notify_all();
    });
    Ok(RawEngine {
        pid,
        pipe: Some(ChildPipe::spawn(ChildStdin(stdin))),
        receiver: Some(receiver),
        ownership,
        drain,
        detached: false,
    })
}

#[cfg(windows)]
pub fn spawn_raw_engine_after<F: FnOnce()>(
    _guard: &ProcessSpawnGuard,
    _command: Command,
    _after_spawn: F,
) -> Result<RawEngine, EngineError> {
    Err(EngineError::Spawn(
        "windows-native-engine-unavailable".into(),
    ))
}

impl RawEngine {
    pub fn pid(&self) -> u32 {
        self.pid
    }
    pub fn pid_is_owned(&self) -> bool {
        self.ownership.exit_record().is_none()
    }

    pub fn recv_event_timeout(
        &mut self,
        bound: Duration,
    ) -> Result<RawEngineEvent, std::sync::mpsc::RecvTimeoutError> {
        self.receiver
            .as_ref()
            .expect("event receiver already taken")
            .recv_timeout(bound)
    }

    pub fn force_kill(&self, bound: Duration) -> Result<ForceKillResult, String> {
        self.ownership.force_kill(bound)
    }

    pub fn write_line(&mut self, line: &str) -> Result<(), PipeError> {
        self.pipe.as_mut().ok_or(PipeError::Gone)?.write(line)
    }

    pub fn close_stdin(&mut self) -> bool {
        self.pipe.as_mut().map(ChildPipe::close).unwrap_or(true)
    }

    pub fn revoke_and_join(mut self, bound: Duration) -> Result<(), String> {
        let deadline = Instant::now() + bound;
        self.drain.revoke();
        self.receiver.take();
        if self.ownership.exit_record().is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            let _ = self.ownership.force_kill(left);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if self.drain.wait(left) {
            Ok(())
        } else {
            Err("generation drain timed out".into())
        }
    }

    pub fn into_parts(
        mut self,
    ) -> (
        ChildPipe,
        RawEventReceiver,
        RawProcessOwnership,
        GenerationDrain,
    ) {
        let pipe = self.pipe.take().expect("raw pipe already taken");
        let receiver = self.receiver.take().expect("raw receiver already taken");
        self.detached = true;
        (pipe, receiver, self.ownership.clone(), self.drain.clone())
    }
}

impl Drop for RawEngine {
    fn drop(&mut self) {
        if !self.detached {
            self.drain.revoke();
            self.receiver.take();
            if self.ownership.is_alive() {
                let _ = self.ownership.force_kill(CONTROL_WRITE_GRACE);
            }
        }
    }
}

pub struct RawEventReceiver {
    receiver: std::sync::mpsc::Receiver<RawEngineEvent>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    completion: Arc<(Mutex<DrainCompletion>, Condvar)>,
}

impl RawEventReceiver {
    pub fn recv_timeout(
        &self,
        bound: Duration,
    ) -> Result<RawEngineEvent, std::sync::mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(bound)
    }

    pub fn revoke(&self) {
        self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn acknowledge_terminated(&self) {
        let (lock, changed) = &*self.completion;
        lock.lock().unwrap_or_else(|p| p.into_inner()).consumer_done = true;
        changed.notify_all();
    }
}

impl Drop for RawEventReceiver {
    fn drop(&mut self) {
        self.acknowledge_terminated();
    }
}

/* =========================================================================
 * Shutdown — the ordering, testable on its own
 * ====================================================================== */

/// The four things a shutdown does to a child, and nothing else.
///
/// Small on purpose: the sequence below is the load-bearing part, and a
/// fake that records the calls is enough to pin its ORDER — which is what
/// actually decides whether a sidecar dies politely or leaves orphans.
pub trait EngineProcess {
    /// Best effort: a refused or unread request changes nothing about the
    /// steps that follow.
    fn write_line(&mut self, line: &str);
    /// Closes the child's stdin. The protocol's third shutdown trigger, and
    /// the only one that works when nobody ever handshook.
    fn close_stdin(&mut self);
    /// Whether the child is still un-reaped. Fed by the process waiter, not
    /// by a pid probe, so a `true` here means the pid cannot have been reused.
    fn alive(&self) -> bool;
    /// SIGKILL. Untrappable, and it orphans the sidecar's own tool children
    /// — which is precisely why it is last.
    fn force_kill(&mut self) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShutdownOutcome {
    /// It ended on its own after being asked — the only good outcome.
    EndedOnRequest,
    /// It outlived the grace window and was killed. Said out loud, because
    /// its tool children are now orphans (G0 §1.4).
    Killed,
    KillFailed(String),
}

/// Ask, close, wait, kill — in that order, always.
///
/// `sleep` is injected so a test can drive the grace window without one.
pub fn shutdown_engine<P: EngineProcess>(
    process: &mut P,
    grace: Duration,
    poll: Duration,
    sleep: &mut dyn FnMut(Duration),
) -> ShutdownOutcome {
    // 1. Say it on the protocol's own terms first: a sidecar that is
    //    listening cancels its run through the run's OWN cancel handler,
    //    which is what makes the outcome `cancelled` instead of an orphaned
    //    `complete`, and what saves the partial answer.
    process.write_line(SHUTDOWN_REQUEST);
    // 2. Close stdin whatever happened to that request. This is the trigger
    //    that does not need a handshake, a reader, or a healthy protocol.
    process.close_stdin();
    // 3. Wait, bounded. An ordinary exit costs one poll.
    let polls = (grace.as_millis() / poll.as_millis().max(1)).max(1) as u64;
    for _ in 0..polls {
        if !process.alive() {
            return ShutdownOutcome::EndedOnRequest;
        }
        sleep(poll);
    }
    if !process.alive() {
        return ShutdownOutcome::EndedOnRequest;
    }
    // 4. The bound. Never reached by a healthy engine.
    match process.force_kill() {
        Ok(()) => ShutdownOutcome::Killed,
        Err(message) => ShutdownOutcome::KillFailed(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    #[cfg(unix)]
    #[test]
    fn task_1_fix_fionread_failure_is_explicit() {
        let error =
            pipe_available_bytes(-1).expect_err("invalid pipe fd must not become zero quota");
        assert_eq!(error.raw_os_error(), Some(libc::EBADF));
    }

    #[derive(Debug, PartialEq, Eq)]
    enum Step {
        Write(String),
        CloseStdin,
        Kill,
    }

    struct FakeProcess {
        log: Vec<Step>,
        /// How many liveness checks the child survives before it is gone.
        alive_for: RefCell<u32>,
        kill_error: Option<String>,
    }

    impl FakeProcess {
        fn new(alive_for: u32) -> Self {
            Self {
                log: Vec::new(),
                alive_for: RefCell::new(alive_for),
                kill_error: None,
            }
        }
    }

    impl EngineProcess for FakeProcess {
        fn write_line(&mut self, line: &str) {
            self.log.push(Step::Write(line.to_string()));
        }
        fn close_stdin(&mut self) {
            self.log.push(Step::CloseStdin);
        }
        fn alive(&self) -> bool {
            let mut left = self.alive_for.borrow_mut();
            if *left == 0 {
                return false;
            }
            *left -= 1;
            true
        }
        fn force_kill(&mut self) -> Result<(), String> {
            self.log.push(Step::Kill);
            match &self.kill_error {
                Some(message) => Err(message.clone()),
                None => Ok(()),
            }
        }
    }

    fn run(process: &mut FakeProcess) -> (ShutdownOutcome, Duration) {
        let mut slept = Duration::ZERO;
        let outcome = shutdown_engine(
            process,
            Duration::from_millis(100),
            Duration::from_millis(10),
            &mut |step| slept += step,
        );
        (outcome, slept)
    }

    #[test]
    fn asks_before_it_closes_and_never_kills_a_child_that_left_on_its_own() {
        let mut process = FakeProcess::new(2);
        let (outcome, _) = run(&mut process);
        assert_eq!(outcome, ShutdownOutcome::EndedOnRequest);
        assert_eq!(
            process.log,
            vec![Step::Write(SHUTDOWN_REQUEST.to_string()), Step::CloseStdin],
            "the request must precede the EOF, and a child that ended must never be killed",
        );
    }

    #[test]
    fn a_child_that_is_already_gone_costs_no_wait_at_all() {
        let mut process = FakeProcess::new(0);
        let (outcome, slept) = run(&mut process);
        assert_eq!(outcome, ShutdownOutcome::EndedOnRequest);
        assert_eq!(slept, Duration::ZERO);
    }

    #[test]
    fn a_wedged_child_is_killed_inside_the_bound() {
        let mut process = FakeProcess::new(u32::MAX);
        let (outcome, slept) = run(&mut process);
        assert_eq!(outcome, ShutdownOutcome::Killed);
        assert!(
            slept <= Duration::from_millis(100),
            "the grace window is a bound, not a suggestion"
        );
        assert_eq!(
            process.log,
            vec![
                Step::Write(SHUTDOWN_REQUEST.to_string()),
                Step::CloseStdin,
                Step::Kill
            ],
            "SIGKILL is last, after the polite request and the EOF",
        );
    }

    #[test]
    fn a_failed_kill_is_reported_rather_than_swallowed() {
        let mut process = FakeProcess::new(u32::MAX);
        process.kill_error = Some("no such process".into());
        let (outcome, _) = run(&mut process);
        assert_eq!(
            outcome,
            ShutdownOutcome::KillFailed("no such process".into())
        );
    }

    #[test]
    fn the_shutdown_request_is_one_protocol_line() {
        assert!(!SHUTDOWN_REQUEST.contains('\n'), "a frame is one line");
        let parsed: serde_json::Value = serde_json::from_str(SHUTDOWN_REQUEST).expect("valid JSON");
        assert_eq!(parsed["t"], "shutdown");
        assert_eq!(parsed["v"], 1);
    }

    #[test]
    fn node_resolution_prefers_the_override_then_the_bundle_then_path() {
        #[cfg(unix)]
        let (override_path, bundled_path, search_path, path_node, fallback) = (
            "/custom/node",
            "/App.app/Contents/Resources/orcode/node",
            "/missing:/from/path",
            "/from/path/node",
            "/usr/local/bin/node",
        );
        #[cfg(windows)]
        let (override_path, bundled_path, search_path, path_node, fallback) = (
            r"C:\Custom\node.exe",
            r"C:\App\orcode\node.exe",
            r"C:\Missing;C:\From Path",
            r"C:\From Path\node.exe",
            r"C:\Fallback\node.exe",
        );
        let bundled = PathBuf::from(bundled_path);
        let exists = |path: &Path| {
            [override_path, bundled_path, path_node, fallback]
                .iter()
                .any(|value| path == Path::new(value))
        };
        let fallbacks = &[fallback];
        assert_eq!(
            resolve_node(
                Some(override_path),
                Some(&bundled),
                Some(search_path),
                fallbacks,
                &exists
            )
            .unwrap(),
            PathBuf::from(override_path)
        );
        assert_eq!(
            resolve_node(None, Some(&bundled), Some(search_path), fallbacks, &exists).unwrap(),
            bundled
        );
        assert_eq!(
            resolve_node(None, None, Some(search_path), fallbacks, &exists).unwrap(),
            PathBuf::from(path_node)
        );
        assert_eq!(
            resolve_node(None, None, None, fallbacks, &exists).unwrap(),
            PathBuf::from(fallback)
        );
    }

    #[test]
    fn a_missing_node_names_every_place_it_looked() {
        #[cfg(unix)]
        let (bundled_path, fallback) = (
            "/App.app/Contents/Resources/orcode/node",
            "/usr/local/bin/node",
        );
        #[cfg(windows)]
        let (bundled_path, fallback) = (r"C:\App\orcode\node.exe", r"C:\Fallback\node.exe");
        let bundled = PathBuf::from(bundled_path);
        let error = resolve_node(
            Some("missing-explicit-runtime"),
            Some(&bundled),
            None,
            &[fallback],
            &|_| false,
        )
        .unwrap_err();
        match error {
            EngineError::NodeMissing { looked_in } => {
                assert!(looked_in
                    .iter()
                    .any(|entry| entry.contains("ORCODE_GUI_NODE")));
                assert!(looked_in.iter().any(|entry| entry == bundled_path));
                assert!(looked_in.iter().any(|entry| entry == fallback));
            }
            other => panic!("expected NodeMissing, got {other:?}"),
        }
    }

    #[test]
    fn provenance_is_a_resolved_path_and_nothing_else() {
        let bundled = PathBuf::from("/App.app/Contents/Resources/orcode/dist/gui-server.js");
        let checkout = PathBuf::from("/repo/dist/gui-server.js");
        assert!(
            is_packaged(Some(&bundled), &bundled),
            "the bundle's own engine"
        );
        assert!(
            !is_packaged(Some(&bundled), &checkout),
            "a checkout engine inside a bundle"
        );
        // A dev build has no bundled candidate at all.
        assert!(!is_packaged(None, &checkout));
        // B-5: `ORCODE_GUI_SERVER` moves this decision because it moves the
        // resolved path — deliberately, and only for someone who set it.
        assert!(!is_packaged(
            Some(&bundled),
            Path::new("/somewhere/else/gui-server.js")
        ));
    }

    #[test]
    fn a_packaged_app_never_uses_the_build_machine_s_fixture_home() {
        // Shipped: the fixture path only exists where this was compiled.
        assert!(uses_real_home(true, false));
        // Dev: never the owner's real home unless they said so.
        assert!(!uses_real_home(false, false));
        assert!(uses_real_home(false, true));
        assert!(uses_real_home(true, true));
    }

    #[test]
    fn the_stderr_tail_is_bounded_and_keeps_the_end() {
        let mut tail = StderrTail::default();
        tail.push(&"noise\n".repeat(4000));
        assert!(tail.text.len() <= STDERR_TAIL_BYTES);
        tail.push("Error: Cannot find module '/x/dist/gui-server.js'\n");
        // The classifying sentence is the LAST one, so it must survive.
        assert_eq!(tail.classify(), Some("engine-module-missing"));
    }

    #[test]
    fn the_tail_never_splits_a_codepoint() {
        let mut tail = StderrTail::default();
        // Multi-byte throughout: a naive byte cut would panic or corrupt.
        tail.push(&"ü".repeat(STDERR_TAIL_BYTES));
        tail.push("SyntaxError: Unexpected end of input\n");
        assert!(
            tail.text.len() <= STDERR_TAIL_BYTES + "SyntaxError: Unexpected end of input\n".len()
        );
        assert_eq!(tail.classify(), Some("engine-syntax"));
    }

    #[test]
    fn a_death_is_classified_into_the_closed_vocabulary_or_not_at_all() {
        // The one G0 predicted: an old node parsing modern syntax reads as a
        // VERSION problem, never as a broken source file.
        assert_eq!(
            classify_exit(
                "/x/dist/gui-server.js:12\nconst a = b?.c;\nSyntaxError: Unexpected token '?'\n"
            ),
            Some("engine-node-too-old"),
        );
        assert_eq!(
            classify_exit("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'"),
            Some("engine-module-missing"),
        );
        assert_eq!(
            classify_exit("SyntaxError: Unexpected end of input"),
            Some("engine-syntax")
        );
        assert_eq!(
            classify_exit("EACCES: permission denied, open '/x'"),
            Some("engine-permission")
        );
        assert_eq!(
            classify_exit("FATAL ERROR: JavaScript heap out of memory"),
            Some("engine-out-of-memory"),
        );
        // Silence classifies as nothing: "we do not know" is a state the
        // window renders honestly, and a guess would be worse than it.
        assert_eq!(classify_exit(""), None);
        assert_eq!(classify_exit("some unremarkable progress line\n"), None);
        // Fix round 1 (B-1): the engine's OWN honest diagnostics live on this
        // stream in normal life, and neither of these is a crash.
        assert_eq!(
            classify_exit("orcode-gui: run failed: Error: the provider returned 429\n"),
            None,
            "a logged provider failure is not an unhandled crash",
        );
        assert_eq!(
            classify_exit(
                "orcode-gui: 3 write(s) were kept off the protocol stream.\nError: model text\n"
            ),
            None,
            "text the R1 guard rerouted must not steer a cause",
        );
        // A real uncaught throw brings its stack with it, and that pair is
        // what the classifier now requires.
        assert_eq!(
            classify_exit(
                "/x/dist/gui-server.js:9\n  throw new Error('boom');\n  ^\n\nError: boom\n    at file:///x/dist/gui-server.js:9:9\n",
            ),
            Some("engine-crashed"),
        );
        assert_eq!(
            classify_exit("[UnhandledPromiseRejection: something]\n"),
            Some("engine-crashed"),
        );
        for cause in EXIT_CAUSES {
            assert!(
                cause.starts_with("engine-"),
                "every cause is a code, not a sentence"
            );
        }
    }

    struct BlockingSink {
        released: Arc<AtomicBool>,
    }

    impl PipeSink for BlockingSink {
        fn write_line(&mut self, _line: &str) -> Result<(), String> {
            // Stands in for a full kernel buffer on a child that stopped
            // reading: the exact 64 KiB edge F5(a) measured.
            while !self.released.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(())
        }
    }

    /// The shipped bounds, scaled down so the wedged cases cost milliseconds.
    const TEST_GRACE: Duration = Duration::from_millis(60);
    const TEST_DEPTH: usize = 4;

    #[test]
    fn a_wedged_write_costs_one_bounded_wait_and_never_the_caller() {
        let released = Arc::new(AtomicBool::new(false));
        let mut pipe = ChildPipe::spawn_with(
            BlockingSink {
                released: Arc::clone(&released),
            },
            TEST_GRACE,
            TEST_DEPTH,
        );
        let began = std::time::Instant::now();
        assert_eq!(pipe.write("{\"t\":\"x\"}"), Err(PipeError::Stalled));
        let waited = began.elapsed();
        assert!(waited >= TEST_GRACE, "the bound is a real wait, not a poll");
        assert!(
            waited < TEST_GRACE * 10,
            "a wedged pipe held its caller for {waited:?}, which is not a bound",
        );
        // And the close is bounded too: the thread is still stuck in the
        // write, so the EOF is not acknowledged — said out loud, not faked.
        assert!(!pipe.close(), "a wedged pipe must not claim a prompt EOF");
        released.store(true, Ordering::SeqCst);
    }

    struct RecordingSink(Arc<Mutex<Vec<String>>>);

    impl PipeSink for RecordingSink {
        fn write_line(&mut self, line: &str) -> Result<(), String> {
            self.0.lock().unwrap().push(line.to_string());
            Ok(())
        }
    }

    #[test]
    fn a_healthy_pipe_writes_in_order_and_closes_at_once() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut pipe = ChildPipe::spawn(RecordingSink(Arc::clone(&log)));
        assert_eq!(pipe.write("one"), Ok(()));
        assert_eq!(pipe.write("two"), Ok(()));
        assert!(pipe.close());
        assert_eq!(
            *log.lock().unwrap(),
            vec!["one".to_string(), "two".to_string()]
        );
        // After the close there is no pipe, and saying so is the truth.
        assert_eq!(pipe.write("three"), Err(PipeError::Gone));
    }

    /// Blocks the FIRST write until released, then writes normally — the
    /// exact shape of a pipe that wedged and then recovered.
    struct StallOnceSink {
        released: Arc<AtomicBool>,
        log: Arc<Mutex<Vec<String>>>,
        stalled: bool,
    }

    impl PipeSink for StallOnceSink {
        fn write_line(&mut self, line: &str) -> Result<(), String> {
            if !self.stalled {
                self.stalled = true;
                while !self.released.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(2));
                }
            }
            self.log.lock().unwrap().push(line.to_string());
            Ok(())
        }
    }

    #[test]
    fn a_late_ack_is_never_handed_to_the_call_that_comes_after_it() {
        // Fix round 1 (B-2). Untagged, this sequence reported "delivered" for
        // a line still sitting in the queue: the stalled write's late ack was
        // the first thing the NEXT `recv_timeout` found.
        let released = Arc::new(AtomicBool::new(false));
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut pipe = ChildPipe::spawn_with(
            StallOnceSink {
                released: Arc::clone(&released),
                log: Arc::clone(&log),
                stalled: false,
            },
            TEST_GRACE,
            TEST_DEPTH,
        );

        assert_eq!(pipe.write("one"), Err(PipeError::Stalled));
        // The pipe recovers: "one" completes and its ack is queued behind
        // nobody, waiting to be mistaken for someone else's.
        released.store(true, Ordering::SeqCst);
        std::thread::sleep(TEST_GRACE);
        assert!(
            log.lock().unwrap().contains(&"one".to_string()),
            "the stalled line did land"
        );

        // The next write must wait for ITS OWN ack — and it must be true.
        assert_eq!(pipe.write("two"), Ok(()));
        assert_eq!(
            *log.lock().unwrap(),
            vec!["one".to_string(), "two".to_string()]
        );

        // And the EOF is only acknowledged by the close's own ticket, never by
        // whatever stale ack happens to be next in the queue.
        assert!(pipe.close());
    }

    /// Fails every write, so a failed ack exists to be mis-attributed.
    struct FailingSink;

    impl PipeSink for FailingSink {
        fn write_line(&mut self, _line: &str) -> Result<(), String> {
            Err("broken pipe".to_string())
        }
    }

    #[test]
    fn a_failure_is_attributed_to_the_line_that_caused_it_and_to_no_other() {
        let mut pipe = ChildPipe::spawn_with(FailingSink, TEST_GRACE, TEST_DEPTH);
        assert_eq!(
            pipe.write("one"),
            Err(PipeError::Failed("broken pipe".into()))
        );
        assert_eq!(
            pipe.write("two"),
            Err(PipeError::Failed("broken pipe".into()))
        );
        // A failed write's ack is not an EOF acknowledgement either.
        assert!(pipe.close());
    }

    #[test]
    fn a_backlog_is_refused_by_name_rather_than_grown() {
        let released = Arc::new(AtomicBool::new(false));
        let mut pipe = ChildPipe::spawn_with(
            BlockingSink {
                released: Arc::clone(&released),
            },
            TEST_GRACE,
            TEST_DEPTH,
        );
        // Every one of these stalls; the queue fills, and then the answer
        // changes from "stalled" to "backlogged" — a refusal, not a leak.
        let mut saw_backlog = false;
        for _ in 0..(TEST_DEPTH + 4) {
            if pipe.write("line") == Err(PipeError::Backlogged) {
                saw_backlog = true;
                break;
            }
        }
        assert!(saw_backlog, "an unread pipe must refuse, not queue forever");
        released.store(true, Ordering::SeqCst);
    }

    #[test]
    fn the_script_falls_back_from_the_bundle_to_the_checkout() {
        let candidates = vec![
            PathBuf::from("/App.app/Contents/Resources/orcode/dist/gui-server.js"),
            PathBuf::from("/repo/dist/gui-server.js"),
        ];
        let exists = |path: &Path| path.starts_with("/repo");
        assert_eq!(
            resolve_script(None, &candidates, &exists).unwrap(),
            PathBuf::from("/repo/dist/gui-server.js"),
        );
        let error = resolve_script(None, &candidates, &|_| false).unwrap_err();
        match error {
            EngineError::ScriptMissing { looked_in } => assert_eq!(looked_in.len(), 2),
            other => panic!("expected ScriptMissing, got {other:?}"),
        }
    }
}
