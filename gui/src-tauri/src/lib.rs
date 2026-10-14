//! orcode's desktop shell.
//!
//! The window owns no logic. It spawns the engine (`dist/gui-server.js`,
//! G1's headless core), pipes one JSON line at a time in both directions,
//! and guarantees the engine dies when the app does. Everything the owner
//! sees is decided on the other side of that pipe.
//!
//! Deliberate omissions, each one a decision rather than an oversight:
//!
//!  * the WebView holds **no** shell permission — not `spawn`, not
//!    `stdin-write`, not `kill`, and above all not `shell:allow-open`
//!    (`capabilities/default.json`). It cannot start a process, and it
//!    cannot hand a URL to the OS.
//!  * the engine's **stderr never reaches the WebView** (G0's R-SEC-5: it is
//!    not protocol, so it never passed the outbound redactor). It goes to
//!    this process's own stderr, where `tauri dev` shows it to a developer.
//!  * `withGlobalTauri` stays off, and the frontend imports what it needs.

pub mod engine;
pub mod packaged_app_trust;
mod platform;
mod manufacturer_cli;

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use url::Url;

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString, NSWorkspace};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSString, NSURL};

use engine::{
    acquire_process_spawn_guard, create_native_sidecar_channels, resolve_node, resolve_script,
    shutdown_engine, spawn_raw_engine_after, try_acquire_process_spawn_guard, ControlPipeWriter,
    EngineError, EngineLaunch, EngineProcess, GenerationDrain, LifecyclePhase, LifecycleStore,
    NativeActionReader, ProcessSpawnGuard, RawEngineEvent, RawProcessOwnership, ShutdownOutcome,
    NODE_FALLBACKS, SHUTDOWN_GRACE, SHUTDOWN_POLL,
};

/* =========================================================================
 * What crosses to the WebView
 * ====================================================================== */

/// Everything the page ever hears from the engine, as one ordered stream.
///
/// A `Channel` and not the event system, because the docs are explicit that
/// events are "not designed for low latency or high throughput" while a
/// channel is "designed to be fast and deliver ordered data" and is what
/// Tauri itself uses for child-process output (G0 §1.9).
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum EngineMessage {
    /// One protocol line, verbatim. The shell does not parse it: the shell
    /// is a pipe, and re-deriving a truth here would be a second
    /// implementation of the protocol.
    Frame { line: String },
    /// The engine ended. Honest state, never a frozen UI.
    ///
    /// `cause` is a CODE from `engine::EXIT_CAUSES` and nothing else. R-SEC-5
    /// holds exactly as before — the engine's stderr never crosses this
    /// boundary; what crosses is one word this shell chose from a closed list
    /// after reading a bounded tail of it. `None` means the tail said nothing
    /// this shell recognises, which the window renders as not knowing rather
    /// than as a guess. G2 concern 4, closed: an engine that dies before
    /// `hello` no longer shows an exit code and nothing else.
    Exited {
        code: Option<i32>,
        signal: Option<i32>,
        cause: Option<String>,
    },
    /// The pipe itself failed — a CODE, never the raw io text.
    ///
    /// Raw pipe errors carry operating-system messages that nobody wrote for
    /// an owner to read. The window receives this fixed code only.
    Failed { code: String },
}

/// A refusal the WINDOW may show: our own words, our own code.
///
/// The same shape the protocol's own `GuiErrorBody` has, for the same
/// reason — a caller can tell a sentence written for a person from an
/// exception string that happens to have a `.message`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<String>,
}

impl From<EngineError> for ShellError {
    fn from(error: EngineError) -> Self {
        // Every sentence here is written for a person. The two variants that
        // carry an operating-system string do NOT put it in the message: it
        // goes to this process's stderr and stays there, exactly as the wire
        // treats an unexplained failure one layer down (`gui-server.ts`).
        match error {
            // These two name only paths the shell itself chose to look in,
            // which is the most useful thing an owner can be told here.
            error @ EngineError::NodeMissing { .. } => Self {
                code: "node-missing".into(),
                message: error.to_string(),
                hint: None,
            },
            error @ EngineError::ScriptMissing { .. } => Self {
                code: "engine-script-missing".into(),
                message: error.to_string(),
                hint: None,
            },
            EngineError::Spawn(detail) => {
                diagnostic(&format!(
                    "orcode-gui: spawning the engine failed: {detail}\n"
                ));
                Self {
                    code: "engine-spawn-failed".into(),
                    message: "The engine could not be started.".into(),
                    hint: Some("The shell's log has the reason.".into()),
                }
            }
            EngineError::NotRunning => Self {
                code: "engine-not-running".into(),
                message: "No engine is running.".into(),
                hint: None,
            },
            EngineError::Io(detail) => {
                diagnostic(&format!(
                    "orcode-gui: the engine connection failed: {detail}\n"
                ));
                Self {
                    code: "engine-io".into(),
                    message: "The connection to the engine failed.".into(),
                    hint: Some("The shell's log has the reason.".into()),
                }
            }
        }
    }
}

/// The facts behind one launch, so a failure can name itself.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    node: String,
    script: String,
    workspace: String,
    home: String,
    real_home: bool,
    pid: u32,
}

/* =========================================================================
 * The live child
 * ====================================================================== */

struct LiveChild {
    pipe: engine::ChildPipe,
    ownership: RawProcessOwnership,
    drain: GenerationDrain,
    // Rust retains the only private action consumer. It is intentionally not
    // exposed to EngineMessage, the WebView, or any Tauri command.
    native_actions: NativeActionRuntime,
}

impl EngineProcess for LiveChild {
    fn write_line(&mut self, line: &str) {
        // Best effort by contract, and now bounded by construction: a sidecar
        // that stopped reading cannot hold the quit before the wait that is
        // supposed to bound it has even started.
        if let Err(error) = self.pipe.write(line) {
            diagnostic(&format!(
                "orcode-gui: the shutdown request did not reach the engine ({error:?}); closing its stdin anyway.\n",
            ));
        }
    }

    fn close_stdin(&mut self) {
        // Drop = EOF. The whole reason D1 chose stdio.
        if !self.pipe.close() {
            // Not "the EOF failed": the pipe thread still owns the child, so
            // the descriptor closes when this process does. What failed is the
            // PROMPTNESS, and the SIGKILL bound below is what covers it.
            diagnostic(
                "orcode-gui: the engine's stdin did not close promptly; it closes with this process.\n",
            );
        }
    }

    fn alive(&self) -> bool {
        self.ownership.is_alive()
    }

    fn force_kill(&mut self) -> Result<(), String> {
        self.ownership.force_kill(engine::PIPE_GRACE).map(|_| ())
    }
}

struct Sidecar {
    lifecycle: LifecycleStore<LiveChild, Channel<EngineMessage>, ControlPipeWriter>,
}

#[derive(Clone)]
struct GenerationStderr {
    tail: Arc<Mutex<engine::StderrTail>>,
}

impl GenerationStderr {
    fn fresh() -> Self {
        Self {
            tail: Arc::new(Mutex::new(engine::StderrTail::default())),
        }
    }

    fn push(&self, chunk: &str) {
        if let Ok(mut tail) = self.tail.lock() {
            tail.push(chunk);
        }
    }

    fn classify(&self) -> Option<String> {
        self.tail
            .lock()
            .ok()
            .and_then(|tail| tail.classify())
            .map(str::to_string)
    }
}

impl Default for Sidecar {
    fn default() -> Self {
        Self {
            lifecycle: LifecycleStore::new(),
        }
    }
}

impl Sidecar {
    fn publish(&self, generation: u64, message: EngineMessage) {
        self.lifecycle.with_current_public(generation, |channel| {
            let _ = channel.send(message);
        });
    }

    fn write_control_current(&self, generation: u64, bytes: &[u8]) -> bool {
        self.lifecycle
            .enqueue_current_control(generation, bytes)
            .and_then(engine::ControlWriteReceipt::wait)
            .is_ok()
    }

    fn shutdown_under_guard(
        &self,
        guard: &ProcessSpawnGuard,
    ) -> Result<Option<ShutdownOutcome>, String> {
        let live = self.lifecycle.take_live_for_stop(guard);
        let Some(live) = live else {
            self.lifecycle.finish_stop(guard);
            return Ok(None);
        };
        match self.finish(live) {
            Ok(outcome) => {
                self.lifecycle.finish_stop(guard);
                Ok(Some(outcome))
            }
            Err((live, reason)) => {
                self.lifecycle.restore_stopping(guard, live);
                Err(reason)
            }
        }
    }

    fn shutdown(&self) -> Result<Option<ShutdownOutcome>, String> {
        let guard = acquire_process_spawn_guard();
        self.shutdown_under_guard(&guard)
    }

    fn shutdown_if_free(&self) -> bool {
        let Some(guard) = try_acquire_process_spawn_guard() else {
            diagnostic("orcode-gui: the process-spawn gate was held while panicking; descriptors close with this process.\n");
            return false;
        };
        let live = match self.lifecycle.try_take_live_for_stop(&guard) {
            Ok(live) => live,
            Err(()) => {
                diagnostic("orcode-gui: the lifecycle state was held while panicking; descriptors close with this process.\n");
                return false;
            }
        };
        if let Some(live) = live {
            let _ = self.finish(live);
        }
        self.lifecycle.finish_stop(&guard);
        true
    }

    fn finish(&self, mut live: LiveChild) -> Result<ShutdownOutcome, (LiveChild, String)> {
        live.native_actions.revoke_all();
        let outcome = shutdown_engine(
            &mut live,
            SHUTDOWN_GRACE,
            SHUTDOWN_POLL,
            &mut std::thread::sleep,
        );
        if !live.ownership.wait_reaped(engine::PIPE_GRACE) {
            return Err((live, "old engine ownership was not reaped".into()));
        }
        if !live.native_actions.wait(engine::PIPE_GRACE) {
            return Err((live, "old private action reader did not drain".into()));
        }
        if !live.drain.wait(engine::PIPE_GRACE) {
            live.drain.revoke();
            if !live.drain.wait(engine::PIPE_GRACE) {
                return Err((live, "old engine generation did not drain".into()));
            }
        }
        if let ShutdownOutcome::Killed | ShutdownOutcome::KillFailed(_) = &outcome {
            // Said out loud: a SIGKILLed engine cannot run its own cleanup,
            // and orcode's tool children sit in their own process groups
            // (workspace.ts), so this is the sentence that explains a stray
            // shell command later.
            diagnostic(&format!(
                "orcode-gui: the engine did not stop within {} ms and was killed; tool processes it started may still be running.\n",
                SHUTDOWN_GRACE.as_millis()
            ));
        }
        Ok(outcome)
    }
}

fn sidecar() -> &'static Arc<Sidecar> {
    static SIDECAR: OnceLock<Arc<Sidecar>> = OnceLock::new();
    SIDECAR.get_or_init(|| Arc::new(Sidecar::default()))
}

fn diagnostic(text: &str) {
    let _ = std::io::stderr().write_all(text.as_bytes());
}

/* =========================================================================
 * Where the engine's pieces come from
 * ====================================================================== */

/// The repo this shell was compiled in — the dev loop's own checkout.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|gui| gui.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref(),
        Some("1" | "true" | "yes")
    )
}

/// A launch's four facts, resolved and stated.
///
/// The home is the important one: by default this is a FIXTURE home under
/// `gui/.devhome`, never `~/.orcode`. The engine derives its whole app-home
/// from `homedir()` (`config.ts`), so `HOME` is the seam — the same discipline
/// the protocol pins and the journey harness use, applied to a dev app so a
/// half-built GUI can never touch the owner's real chats, config or keys.
/// `--real-home` (or `ORCODE_GUI_REAL_HOME=1`) is the deliberate opt-in.
fn plan_launch(app: &AppHandle) -> Result<EngineLaunch, EngineError> {
    // The staged runtime a packaged build carries (`npm run gui:package`).
    // Absent in a dev build, which is why every fallback below still exists.
    let resources = app.path().resource_dir().ok();
    let bundled_node = resources.as_ref().map(|dir| dir.join("orcode").join(platform::NODE_BINARY_NAME));
    let node = resolve_node(
        std::env::var("ORCODE_GUI_NODE").ok().as_deref(),
        bundled_node.as_deref(),
        std::env::var("PATH").ok().as_deref(),
        NODE_FALLBACKS,
        &|path| path.exists(),
    )?;
    let bundled_script = resources
        .as_ref()
        .map(|dir| dir.join("orcode/dist/gui-server.js"));
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(script) = bundled_script.as_ref() {
        candidates.push(script.clone());
    }
    candidates.push(repo_root().join("dist/gui-server.js"));
    // B-5: this override moves the PROVENANCE decision below, because it
    // moves the resolved path — pointing it outside a bundle makes a packaged
    // app resolve as "dev" (fixture home), and pointing it at a staged
    // Resources copy makes a dev context resolve as "real home" without
    // `--real-home`. That is the override rule working as written, and it is
    // reachable only by a developer who set the variable for this process:
    // launchd hands a Finder launch none of it. It is said out loud below so
    // it is never a silent flip.
    let server_override = std::env::var("ORCODE_GUI_SERVER").ok();
    let script = resolve_script(server_override.as_deref(), &candidates, &|path| {
        path.exists()
    })?;

    // Which app is this? The engine's own provenance answers it: an engine
    // that came out of this bundle's Resources is a SHIPPED app; one that
    // came out of the repo checkout this binary was compiled in is the dev
    // loop. The distinction decides the home, and getting it wrong is a
    // ship defect either way — a dev build that touched `~/.orcode` would
    // put a half-built GUI on the owner's real chats, and a shipped app that
    // defaulted to `gui/.devhome` would point at a path from the BUILD
    // machine that does not exist on the owner's (measured: the packaged app
    // did exactly that until this line existed).
    let packaged = engine::is_packaged(bundled_script.as_deref(), &script);
    let real_home = engine::uses_real_home(
        packaged,
        env_flag("ORCODE_GUI_REAL_HOME") || std::env::args().any(|arg| arg == "--real-home"),
    );
    if server_override.is_some() {
        diagnostic(&format!(
            "orcode-gui: ORCODE_GUI_SERVER is set, so this launch resolves as {} and will use the {} app home.\n",
            if packaged { "PACKAGED" } else { "a dev build" },
            if real_home { "real" } else { "fixture" },
        ));
    }

    let fixture_home = repo_root().join("gui/.devhome");
    let home = if real_home {
        dirs_home().ok_or_else(|| EngineError::Io("The user home directory is unavailable.".into()))?
    } else {
        fixture_home.clone()
    };
    let workspace = match std::env::var("ORCODE_GUI_WORKSPACE")
        .ok()
        .filter(|value| !value.is_empty())
    {
        Some(value) => PathBuf::from(value),
        None if real_home => home.clone(),
        None => fixture_home.join("workspace"),
    };
    if !real_home {
        // Only ever creates the fixture, never anything under the real home.
        std::fs::create_dir_all(&workspace).map_err(|error| EngineError::Io(error.to_string()))?;
        std::fs::create_dir_all(home.join(".orcode"))
            .map_err(|error| EngineError::Io(error.to_string()))?;
    }
    Ok(EngineLaunch {
        node,
        script,
        cwd: workspace,
        home,
        real_home,
    })
}

fn dirs_home() -> Option<PathBuf> {
    platform::home_from_env(|key| std::env::var_os(key))
}

/* =========================================================================
 * Commands
 * ====================================================================== */

const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeRoute {
    version: u8,
    backend_id: String,
    account_fingerprint: String,
    billing_realm: String,
    requested_model_id: String,
    canonical_model_id: Option<String>,
    resolution_state: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum NativeActionRecord {
    PackagedStartup {
        request_id: String,
        challenge: String,
        session_id: String,
        child_pid: u32,
        action_channel_id: String,
        control_channel_id: String,
    },
    KimiSetup {
        request_id: String,
        session_id: String,
        child_pid: u32,
        setup_id: String,
        provider: String,
        operation: String,
        revision: u64,
        generation: u64,
        deadline_at: u64,
    },
    KimiTurn {
        request_id: String,
        session_id: String,
        child_pid: u32,
        run_id: String,
        route: NativeRoute,
        request_digest: String,
        revision: u64,
        generation: u64,
        deadline_at: u64,
    },
    KimiCross {
        request_id: String,
        session_id: String,
        child_pid: u32,
        cross_run_id: String,
        lead: NativeRoute,
        challenger: NativeRoute,
        repair_budget: u8,
        request_budget_per_stage: u8,
        revision: u64,
        generation: u64,
        deadline_at: u64,
    },
    Revoke {
        request_id: String,
        session_id: String,
        child_pid: u32,
        revision: u64,
        generation: u64,
        deadline_at: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeLocalActionPresentation {
    pub provider: &'static str,
    pub purpose: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeFence {
    request_id: String,
    session_id: String,
    child_pid: u32,
    revision: u64,
    generation: u64,
    deadline_at: u64,
}

impl NativeActionRecord {
    fn fence(&self) -> NativeFence {
        match self {
            Self::PackagedStartup { .. } => unreachable!("startup records have no permit fence"),
            Self::KimiSetup {
                request_id,
                session_id,
                child_pid,
                revision,
                generation,
                deadline_at,
                ..
            }
            | Self::KimiTurn {
                request_id,
                session_id,
                child_pid,
                revision,
                generation,
                deadline_at,
                ..
            }
            | Self::KimiCross {
                request_id,
                session_id,
                child_pid,
                revision,
                generation,
                deadline_at,
                ..
            }
            | Self::Revoke {
                request_id,
                session_id,
                child_pid,
                revision,
                generation,
                deadline_at,
            } => NativeFence {
                request_id: request_id.clone(),
                session_id: session_id.clone(),
                child_pid: *child_pid,
                revision: *revision,
                generation: *generation,
                deadline_at: *deadline_at,
            },
        }
    }

    fn presentation(&self) -> Option<NativeLocalActionPresentation> {
        let purpose = match self {
            Self::KimiSetup { .. } => "Mitgliedschaft verbinden",
            Self::KimiTurn { .. } => "Nachricht senden",
            Self::KimiCross { .. } => "Cross starten",
            Self::Revoke { .. } | Self::PackagedStartup { .. } => return None,
        };
        Some(NativeLocalActionPresentation {
            provider: "Kimi Code",
            purpose,
        })
    }
}

fn bounded_text(value: &str) -> bool {
    let utf16_units = value.encode_utf16().count();
    (1..=256).contains(&utf16_units)
        && !value
            .chars()
            .any(|character| character <= '\u{001f}' || character == '\u{007f}')
}

fn request_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_route(route: &NativeRoute) -> bool {
    route.version == 1
        && matches!(
            route.backend_id.as_str(),
            "openrouter" | "kimi-code" | "codex" | "anthropic"
        )
        && matches!(
            route.billing_realm.as_str(),
            "openrouter-payg"
                | "kimi-code-membership-provider-managed-overage"
                | "chatgpt-subscription-provider-managed-overage"
                | "chatgpt-account-provider-managed-limits"
                | "none"
        )
        && matches!(
            route.resolution_state.as_str(),
            "legacy-unverified" | "resolved"
        )
        && bounded_text(&route.account_fingerprint)
        && bounded_text(&route.requested_model_id)
        && route
            .canonical_model_id
            .as_deref()
            .map(bounded_text)
            .unwrap_or(true)
}

fn valid_kimi_route(route: &NativeRoute) -> bool {
    valid_route(route)
        && route.backend_id == "kimi-code"
        && route.billing_realm == "kimi-code-membership-provider-managed-overage"
        && route.resolution_state == "resolved"
        && route.canonical_model_id.is_some()
}

fn validate_native_action(record: &NativeActionRecord, actual_pid: u32, now: u64) -> bool {
    if let NativeActionRecord::PackagedStartup {
        request_id,
        challenge,
        session_id,
        child_pid,
        action_channel_id,
        control_channel_id,
    } = record
    {
        return request_id.len() == 32
            && request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && (22..=128).contains(&challenge.len())
            && challenge
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && bounded_text(session_id)
            && *child_pid == actual_pid
            && action_channel_id == "fd:198"
            && control_channel_id == "fd:199";
    }
    let fence = record.fence();
    if !request_id(&fence.request_id)
        || !bounded_text(&fence.session_id)
        || fence.child_pid != actual_pid
        || fence.revision > MAX_SAFE_JSON_INTEGER
        || fence.generation > MAX_SAFE_JSON_INTEGER
        || fence.deadline_at > MAX_SAFE_JSON_INTEGER
    {
        return false;
    }
    if !matches!(record, NativeActionRecord::Revoke { .. }) && fence.deadline_at <= now {
        return false;
    }
    match record {
        NativeActionRecord::KimiSetup {
            setup_id,
            provider,
            operation,
            ..
        } => {
            bounded_text(setup_id)
                && provider == "kimi-code"
                && matches!(operation.as_str(), "initial-setup" | "replace")
        }
        NativeActionRecord::KimiTurn {
            run_id,
            route,
            request_digest,
            ..
        } => bounded_text(run_id) && valid_kimi_route(route) && digest(request_digest),
        NativeActionRecord::KimiCross {
            cross_run_id,
            lead,
            challenger,
            repair_budget,
            request_budget_per_stage,
            ..
        } => {
            bounded_text(cross_run_id)
                && valid_route(lead)
                && valid_route(challenger)
                && (lead.backend_id != "kimi-code" || valid_kimi_route(lead))
                && (challenger.backend_id != "kimi-code" || valid_kimi_route(challenger))
                && (lead.backend_id == "kimi-code" || challenger.backend_id == "kimi-code")
                && *repair_budget <= 1
                && (1..=100).contains(request_budget_per_stage)
        }
        NativeActionRecord::Revoke { .. } => true,
        NativeActionRecord::PackagedStartup { .. } => unreachable!(),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CodexNativeActionRecord {
    ManufacturerCliPrepare {
        request_id: String,
        child_generation: u64,
        provider: manufacturer_cli::Provider,
        action: manufacturer_cli::Action,
        deadline_at: u64,
    },
    CodexBrowserLoginPrepare {
        request_id: String,
        child_generation: u64,
        login_id: String,
        auth_url: String,
        deadline_at: u64,
    },
    CodexDeviceLoginPrepare {
        request_id: String,
        child_generation: u64,
        login_id: String,
        verification_url: String,
        user_code: String,
        deadline_at: u64,
    },
    CodexNativeActionCommit {
        request_id: String,
        child_generation: u64,
        deadline_at: u64,
    },
    CodexNativeActionRevoke {
        request_id: String,
        child_generation: u64,
        deadline_at: u64,
    },
}

impl CodexNativeActionRecord {
    fn request_id(&self) -> &str {
        match self {
            Self::CodexBrowserLoginPrepare { request_id, .. }
            | Self::ManufacturerCliPrepare { request_id, .. }
            | Self::CodexDeviceLoginPrepare { request_id, .. }
            | Self::CodexNativeActionCommit { request_id, .. }
            | Self::CodexNativeActionRevoke { request_id, .. } => request_id,
        }
    }

    fn child_generation(&self) -> u64 {
        match self {
            Self::CodexBrowserLoginPrepare {
                child_generation, ..
            }
            | Self::ManufacturerCliPrepare { child_generation, .. }
            | Self::CodexDeviceLoginPrepare {
                child_generation, ..
            }
            | Self::CodexNativeActionCommit {
                child_generation, ..
            }
            | Self::CodexNativeActionRevoke {
                child_generation, ..
            } => *child_generation,
        }
    }

    fn deadline_at(&self) -> u64 {
        match self {
            Self::CodexBrowserLoginPrepare { deadline_at, .. }
            | Self::ManufacturerCliPrepare { deadline_at, .. }
            | Self::CodexDeviceLoginPrepare { deadline_at, .. }
            | Self::CodexNativeActionCommit { deadline_at, .. }
            | Self::CodexNativeActionRevoke { deadline_at, .. } => *deadline_at,
        }
    }

    fn presentation(&self) -> Option<CodexNativeLoginPresentation> {
        match self {
            Self::ManufacturerCliPrepare {provider, action, ..} => Some(CodexNativeLoginPresentation::Manufacturer {
                provider: *provider, action: *action,
            }),
            Self::CodexBrowserLoginPrepare { auth_url, .. } => {
                Some(CodexNativeLoginPresentation::Browser {
                    auth_url: auth_url.clone(),
                })
            }
            Self::CodexDeviceLoginPrepare {
                verification_url,
                user_code,
                ..
            } => Some(CodexNativeLoginPresentation::Device {
                verification_url: verification_url.clone(),
                user_code: user_code.clone(),
            }),
            Self::CodexNativeActionCommit { .. } | Self::CodexNativeActionRevoke { .. } => None,
        }
    }

    fn is_prepare(&self) -> bool {
        matches!(
            self,
            Self::CodexBrowserLoginPrepare { .. } | Self::CodexDeviceLoginPrepare { .. } | Self::ManufacturerCliPrepare { .. }
        )
    }

    fn is_commit(&self) -> bool {
        matches!(self, Self::CodexNativeActionCommit { .. })
    }

    fn is_revoke(&self) -> bool {
        matches!(self, Self::CodexNativeActionRevoke { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum CodexNativeLoginPresentation {
    Manufacturer {provider:manufacturer_cli::Provider, action:manufacturer_cli::Action},
    Browser {
        auth_url: String,
    },
    Device {
        verification_url: String,
        user_code: String,
    },
}

trait CodexNativeLoginPresenter: Send + Sync {
    fn present(
        &self,
        presentation: CodexNativeLoginPresentation,
        authorization: CodexPresentationAuthorization,
    ) -> bool;
}

#[derive(Clone)]
struct CodexPresentationAuthorization {
    revoked: Arc<std::sync::atomic::AtomicBool>,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl CodexPresentationAuthorization {
    fn new(current: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            revoked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            current: Arc::new(current),
        }
    }

    fn is_current(&self) -> bool {
        !self.revoked.load(std::sync::atomic::Ordering::SeqCst) && (self.current)()
    }

    fn revoke(&self) {
        self.revoked
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn run_if_current(&self, effect: impl FnOnce() -> bool) -> bool {
        self.is_current() && effect()
    }
}

#[cfg(test)]
struct RejectingCodexNativeLoginPresenter;

#[cfg(test)]
impl CodexNativeLoginPresenter for RejectingCodexNativeLoginPresenter {
    fn present(
        &self,
        _presentation: CodexNativeLoginPresentation,
        authorization: CodexPresentationAuthorization,
    ) -> bool {
        authorization.revoke();
        false
    }
}

struct TauriCodexNativeLoginPresenter {
    app: AppHandle,
}

impl CodexNativeLoginPresenter for TauriCodexNativeLoginPresenter {
    fn present(
        &self,
        presentation: CodexNativeLoginPresentation,
        authorization: CodexPresentationAuthorization,
    ) -> bool {
        let (sent, received) = std::sync::mpsc::sync_channel(1);
        let app = self.app.clone();
        let queued_authorization = authorization.clone();
        if app
            .clone()
            .run_on_main_thread(move || {
                let presented =
                    present_codex_login_on_main(&app, presentation, queued_authorization);
                let _ = sent.try_send(presented);
            })
            .is_err()
        {
            authorization.revoke();
            return false;
        }
        match received.recv_timeout(Duration::from_secs(1)) {
            Ok(true) if authorization.is_current() => true,
            _ => {
                authorization.revoke();
                false
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn present_codex_login_on_main(
    app: &AppHandle,
    presentation: CodexNativeLoginPresentation,
    authorization: CodexPresentationAuthorization,
) -> bool {
    match presentation {
        CodexNativeLoginPresentation::Manufacturer {provider, action} => {
            let approval = authorization.clone();
            let body = manufacturer_cli::instructions(provider, action);
            authorization.run_if_current(|| {
                app.dialog().message(body).title("Hersteller-CLI einrichten")
                    .buttons(MessageDialogButtons::OkCancelCustom("Im Terminal öffnen".into(), "Abbrechen".into()))
                    .show(move |accepted| {
                        if accepted {
                            approval.run_if_current(|| manufacturer_cli::open_terminal(provider, action));
                        }
                    });
                true
            })
        }
        CodexNativeLoginPresentation::Browser { auth_url } => {
            let source = NSString::from_str(&auth_url);
            let Some(url) = NSURL::URLWithString(&source) else {
                return false;
            };
            authorization.run_if_current(|| NSWorkspace::sharedWorkspace().openURL(&url))
        }
        CodexNativeLoginPresentation::Device {
            verification_url,
            user_code,
        } => {
            let code_for_copy = user_code.clone();
            let copy_authorization = authorization.clone();
            authorization.run_if_current(|| {
                app.dialog()
                    .message(format!(
                        "Öffne {verification_url} und gib diesen Code ein:\n\n{user_code}"
                    ))
                    .title("ChatGPT anmelden")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Code kopieren".into(),
                        "Schließen".into(),
                    ))
                    .show(move |copy| {
                        if copy {
                            copy_authorization.run_if_current(|| {
                                let pasteboard = NSPasteboard::generalPasteboard();
                                pasteboard.clearContents();
                                pasteboard.setString_forType(
                                    &NSString::from_str(&code_for_copy),
                                    unsafe { NSPasteboardTypeString },
                                );
                                true
                            });
                        }
                    });
                true
            })
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn present_codex_login_on_main(
    _app: &AppHandle,
    _presentation: CodexNativeLoginPresentation,
    authorization: CodexPresentationAuthorization,
) -> bool {
    authorization.revoke();
    false
}

fn parse_codex_native_action(
    bytes: &[u8],
    launch_generation: u64,
    now: u64,
) -> Result<CodexNativeActionRecord, ()> {
    let record: CodexNativeActionRecord = serde_json::from_slice(bytes).map_err(|_| ())?;
    if !request_id(record.request_id())
        || record.child_generation() != launch_generation
        || record.child_generation() > MAX_SAFE_JSON_INTEGER
        || record.deadline_at() > MAX_SAFE_JSON_INTEGER
        || (!record.is_revoke() && record.deadline_at() <= now)
    {
        return Err(());
    }
    let valid = match &record {
        CodexNativeActionRecord::ManufacturerCliPrepare { .. } => true,
        CodexNativeActionRecord::CodexBrowserLoginPrepare {
            login_id, auth_url, ..
        } => bounded_text(login_id) && valid_codex_browser_url(auth_url),
        CodexNativeActionRecord::CodexDeviceLoginPrepare {
            login_id,
            verification_url,
            user_code,
            ..
        } => {
            bounded_text(login_id)
                && valid_codex_device_url(verification_url)
                && valid_codex_user_code(user_code)
        }
        CodexNativeActionRecord::CodexNativeActionCommit { .. }
        | CodexNativeActionRecord::CodexNativeActionRevoke { .. } => true,
    };
    valid.then_some(record).ok_or(())
}

fn valid_codex_browser_url(source: &str) -> bool {
    const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
    const SCOPE: &str = "openid profile email offline_access";
    const ORIGINATOR: &str = "codex_cli_rs";
    if !source.starts_with("https://auth.openai.com/oauth/authorize?") {
        return false;
    }
    let Ok(url) = Url::parse(source) else {
        return false;
    };
    if url.as_str() != source
        || url.scheme() != "https"
        || url.host_str() != Some("auth.openai.com")
        || url.path() != "/oauth/authorize"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
    {
        return false;
    }
    let Some(raw_query) = url.query() else {
        return false;
    };
    if raw_query.is_empty() || raw_query.split('&').any(str::is_empty) {
        return false;
    }
    let required = [
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("scope", SCOPE),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("originator", ORIGINATOR),
    ];
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    for (key, expected) in required {
        if pairs.iter().filter(|(actual, _)| actual == key).count() != 1
            || !pairs
                .iter()
                .any(|(actual, value)| actual == key && value == expected)
        {
            return false;
        }
    }
    for key in ["redirect_uri", "code_challenge", "state"] {
        if pairs.iter().filter(|(actual, _)| actual == key).count() != 1 {
            return false;
        }
    }
    if pairs
        .iter()
        .filter(|(key, _)| key == "allowed_workspace_id")
        .count()
        > 1
        || pairs.iter().any(|(key, _)| {
            !required.iter().any(|(name, _)| name == key)
                && !matches!(
                    key.as_str(),
                    "redirect_uri" | "code_challenge" | "state" | "allowed_workspace_id"
                )
        })
    {
        return false;
    }
    let take = |key: &str| {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    };
    let challenge = take("code_challenge").unwrap_or_default();
    let state = take("state").unwrap_or_default();
    if !base64url(challenge, 43, 128) || !base64url(state, 32, 128) {
        return false;
    }
    if take("allowed_workspace_id").map(bounded_text) == Some(false) {
        return false;
    }
    let redirect_source = take("redirect_uri").unwrap_or_default();
    if redirect_source.contains('%') || !redirect_source.starts_with("http://localhost:") {
        return false;
    }
    let Ok(redirect) = Url::parse(redirect_source) else {
        return false;
    };
    let Some(port) = redirect.port() else {
        return false;
    };
    if redirect.as_str() != redirect_source
        || redirect_source != format!("http://localhost:{port}/auth/callback")
        || redirect.scheme() != "http"
        || redirect.host_str() != Some("localhost")
        || !redirect.username().is_empty()
        || redirect.password().is_some()
        || redirect.path() != "/auth/callback"
        || redirect.query().is_some()
        || redirect.fragment().is_some()
        || !(1024..=65535).contains(&port)
    {
        return false;
    }
    true
}

fn valid_codex_device_url(source: &str) -> bool {
    source == "https://auth.openai.com/codex/device"
        && Url::parse(source)
            .map(|url| {
                url.scheme() == "https"
                    && url.host_str() == Some("auth.openai.com")
                    && url.path() == "/codex/device"
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.port().is_none()
                    && url.username().is_empty()
                    && url.password().is_none()
            })
            .unwrap_or(false)
}

fn valid_codex_user_code(value: &str) -> bool {
    value.len() == 9
        && value.as_bytes()[4] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn base64url(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[derive(Default)]
struct CodexNativeActionState {
    pending: HashMap<String, CodexNativeActionRecord>,
    live: HashMap<String, CodexLivePresentation>,
    seen: HashSet<String>,
}

struct CodexLivePresentation {
    child_generation: u64,
    deadline_at: u64,
    authorization: CodexPresentationAuthorization,
}

impl CodexNativeActionState {
    fn revoke_all(&mut self) {
        self.pending.clear();
        for (_, live) in self.live.drain() {
            live.authorization.revoke();
        }
    }
}

const CODEX_NATIVE_ACTION_HISTORY_CAP: usize = 1_024;

fn handle_codex_native_action(
    state: &mut CodexNativeActionState,
    record: CodexNativeActionRecord,
    presenter: Arc<dyn CodexNativeLoginPresenter>,
    control: Arc<dyn PrivateControlSink>,
    authorization: CodexPresentationAuthorization,
) -> Result<(), ()> {
    let request_id = record.request_id().to_string();
    if record.is_prepare() {
        // PREPARE may already be fully readable while Node still observes its
        // descriptor write as pending. It stores private presentation data but
        // is deliberately incapable of calling the presenter before COMMIT.
        if state.seen.len() >= CODEX_NATIVE_ACTION_HISTORY_CAP
            || state.seen.contains(&request_id)
            || state.pending.contains_key(&request_id)
            || state.live.contains_key(&request_id)
        {
            state.revoke_all();
            return Err(());
        }
        state.seen.insert(request_id.clone());
        state.pending.insert(request_id, record);
        return Ok(());
    }
    if record.is_revoke() {
        if let Some(prepared) = state.pending.get(&request_id) {
            if prepared.child_generation() != record.child_generation()
                || prepared.deadline_at() != record.deadline_at()
            {
                state.revoke_all();
                return Err(());
            }
            state.pending.remove(&request_id);
            return Ok(());
        }
        if let Some(live) = state.live.get(&request_id) {
            if live.child_generation != record.child_generation()
                || live.deadline_at != record.deadline_at()
            {
                state.revoke_all();
                return Err(());
            }
        } else {
            state.revoke_all();
            return Err(());
        }
        if let Some(live) = state.live.remove(&request_id) {
            live.authorization.revoke();
        }
        return Ok(());
    }
    if !record.is_commit() {
        state.revoke_all();
        return Err(());
    }
    let Some(prepared) = state.pending.remove(&request_id) else {
        state.revoke_all();
        return Err(());
    };
    if prepared.child_generation() != record.child_generation()
        || prepared.deadline_at() != record.deadline_at()
    {
        state.revoke_all();
        return Err(());
    }
    let Some(presentation) = prepared.presentation() else {
        state.revoke_all();
        return Err(());
    };
    state.live.insert(
        request_id.clone(),
        CodexLivePresentation {
            child_generation: record.child_generation(),
            deadline_at: record.deadline_at(),
            authorization: authorization.clone(),
        },
    );
    let presented = authorization.is_current()
        && presenter.present(presentation, authorization.clone())
        && authorization.is_current();
    if !presented {
        authorization.revoke();
        state.live.remove(&request_id);
    }
    let status = if presented { "presented" } else { "failed" };
    let value = serde_json::json!({
        "kind": "codex-native-action-result",
        "requestId": request_id,
        "childGeneration": record.child_generation(),
        "status": status,
    });
    let bytes = serde_json::to_vec(&value).map_err(|_| ())?;
    if bytes.len() > engine::MAX_PRIVATE_PAYLOAD || !control.write_control(&bytes) {
        state.revoke_all();
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
fn parse_native_action(bytes: &[u8], actual_pid: u32, now: u64) -> Result<NativeActionRecord, ()> {
    let record: NativeActionRecord = serde_json::from_slice(bytes).map_err(|_| ())?;
    validate_native_action(&record, actual_pid, now)
        .then_some(record)
        .ok_or(())
}

/// Rust-only native confirmation surface. The only data the implementation
/// accepts is a closed, secretless provider/purpose pair.
pub trait NativeLocalActionPrompter: Send + Sync {
    fn show(
        &self,
        presentation: NativeLocalActionPresentation,
        callback: Box<dyn FnOnce(bool) + Send>,
    );
}

pub struct TauriNativeLocalActionPrompter {
    app: AppHandle,
}

impl NativeLocalActionPrompter for TauriNativeLocalActionPrompter {
    fn show(
        &self,
        presentation: NativeLocalActionPresentation,
        callback: Box<dyn FnOnce(bool) + Send>,
    ) {
        let purpose = match presentation.purpose {
            "Mitgliedschaft verbinden" | "Nachricht senden" | "Cross starten" => {
                presentation.purpose
            }
            _ => return,
        };
        self.app
            .dialog()
            .message(format!("{}: {purpose}?", presentation.provider))
            .title("Native Bestätigung")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Erlauben".into(),
                "Abbrechen".into(),
            ))
            .show(callback);
    }
}

trait PrivateControlSink: Send + Sync {
    fn write_control(&self, bytes: &[u8]) -> bool;
}

/// A native callback captures exactly one generation. Comparison and enqueue
/// both happen under the consolidated lifecycle-state lock.
#[derive(Clone)]
pub struct GenerationBoundControlWriter {
    sidecar: Arc<Sidecar>,
    generation: u64,
}

impl GenerationBoundControlWriter {
    pub fn try_write_current(&self, generation: u64, bytes: &[u8]) -> bool {
        generation == self.generation && self.sidecar.write_control_current(generation, bytes)
    }
}

impl PrivateControlSink for GenerationBoundControlWriter {
    fn write_control(&self, bytes: &[u8]) -> bool {
        self.try_write_current(self.generation, bytes)
    }
}

struct PendingNativeAction {
    token: u64,
    request: NativeActionRecord,
}

struct NativeActionState {
    active: bool,
    next_token: u64,
    pending: Option<PendingNativeAction>,
    seen: HashSet<String>,
    startup_seen: bool,
    startup_attested: bool,
}

const NATIVE_ACTION_HISTORY_CAP: usize = 1_024;
const DEADLINE_RECHECK_HORIZON: Duration = Duration::from_secs(1);

type DeadlineThreadSpawner =
    fn(Box<dyn FnOnce() + Send>) -> std::io::Result<std::thread::JoinHandle<()>>;

fn spawn_deadline_thread(
    job: Box<dyn FnOnce() + Send>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("orcode-kimi-deadline".into())
        .spawn(job)
}

struct DeadlineWorkerSignal {
    started: bool,
    cancelled: bool,
}

struct DeadlineWorker {
    token: u64,
    signal: Arc<(Mutex<DeadlineWorkerSignal>, Condvar)>,
    handle: std::thread::JoinHandle<()>,
}

#[derive(Clone)]
struct NativeActionCoordinator {
    actual_pid: u32,
    launch_generation: u64,
    verified_packaged_app: Option<crate::packaged_app_trust::VerifiedPackagedApp>,
    control: Arc<dyn PrivateControlSink>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    state: Arc<Mutex<NativeActionState>>,
    deadline_worker: Arc<Mutex<Option<DeadlineWorker>>>,
    deadline_spawner: DeadlineThreadSpawner,
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn base64url_nonce(bytes: [u8; 16]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity(22);
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    for byte in bytes {
        accumulator = (accumulator << 8) | u32::from(byte);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            output.push(TABLE[((accumulator >> bits) & 0x3f) as usize] as char);
        }
    }
    if bits > 0 {
        output.push(TABLE[((accumulator << (6 - bits)) & 0x3f) as usize] as char);
    }
    output
}

impl NativeActionCoordinator {
    fn new(
        actual_pid: u32,
        launch_generation: u64,
        control: Arc<dyn PrivateControlSink>,
        now: impl Fn() -> u64 + Send + Sync + 'static,
    ) -> Self {
        let verified_packaged_app = crate::packaged_app_trust::verify_without_policy().ok();
        let active = verified_packaged_app.is_some();
        Self {
            actual_pid,
            launch_generation,
            verified_packaged_app,
            control,
            now: Arc::new(now),
            state: Arc::new(Mutex::new(NativeActionState {
                active,
                next_token: 0,
                pending: None,
                seen: HashSet::new(),
                startup_seen: false,
                startup_attested: false,
            })),
            deadline_worker: Arc::new(Mutex::new(None)),
            deadline_spawner: spawn_deadline_thread,
        }
    }

    #[cfg(test)]
    fn new_with_scheduler(
        actual_pid: u32,
        launch_generation: u64,
        control: Arc<dyn PrivateControlSink>,
        now: impl Fn() -> u64 + Send + Sync + 'static,
        deadline_spawner: DeadlineThreadSpawner,
    ) -> Self {
        Self {
            actual_pid,
            launch_generation,
            verified_packaged_app: None,
            control,
            now: Arc::new(now),
            state: Arc::new(Mutex::new(NativeActionState {
                active: true,
                next_token: 0,
                pending: None,
                seen: HashSet::new(),
                startup_seen: true,
                startup_attested: true,
            })),
            deadline_worker: Arc::new(Mutex::new(None)),
            deadline_spawner,
        }
    }

    #[cfg(test)]
    fn new_with_verified_packaged_app(
        actual_pid: u32,
        launch_generation: u64,
        verified_packaged_app: crate::packaged_app_trust::VerifiedPackagedApp,
        control: Arc<dyn PrivateControlSink>,
        now: impl Fn() -> u64 + Send + Sync + 'static,
    ) -> Self {
        Self {
            actual_pid,
            launch_generation,
            verified_packaged_app: Some(verified_packaged_app),
            control,
            now: Arc::new(now),
            state: Arc::new(Mutex::new(NativeActionState {
                active: true,
                next_token: 0,
                pending: None,
                seen: HashSet::new(),
                startup_seen: false,
                startup_attested: false,
            })),
            deadline_worker: Arc::new(Mutex::new(None)),
            deadline_spawner: spawn_deadline_thread,
        }
    }

    fn handle_packaged_startup(&self, record: NativeActionRecord) -> Result<(), ()> {
        let NativeActionRecord::PackagedStartup {
            request_id,
            challenge,
            session_id,
            child_pid,
            action_channel_id,
            control_channel_id,
        } = record
        else {
            return Err(());
        };
        if !validate_native_action(
            &NativeActionRecord::PackagedStartup {
                request_id: request_id.clone(),
                challenge: challenge.clone(),
                session_id: session_id.clone(),
                child_pid,
                action_channel_id: action_channel_id.clone(),
                control_channel_id: control_channel_id.clone(),
            },
            self.actual_pid,
            (self.now)(),
        ) {
            self.revoke_all();
            return Err(());
        }
        let Some(verified) = self.verified_packaged_app.as_ref() else {
            self.revoke_all();
            return Err(());
        };
        {
            let mut state = self.state.lock().map_err(|_| ())?;
            if !state.active || state.startup_seen {
                state.active = false;
                return Err(());
            }
            state.startup_seen = true;
            state.startup_attested = true;
        }
        let hex = |bytes: &[u8]| {
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        let value = serde_json::json!({ "kind":"packaged-attestation", "requestId":request_id, "challenge":challenge,
            "sessionId":session_id, "childPid":child_pid, "generation":self.launch_generation,
            "actionChannelId":action_channel_id, "controlChannelId":control_channel_id,
            "executablePath":verified.executable_path(), "executableDevice":verified.executable_device(),
            "executableInode":verified.executable_inode(), "executableSize":verified.executable_size(),
            "policySha256":hex(verified.policy_sha256()), "executableSha256":hex(verified.executable_sha256()) });
        let bytes = serde_json::to_vec(&value).map_err(|_| ())?;
        if !self.control.write_control(&bytes) {
            self.revoke_all();
            return Err(());
        }
        Ok(())
    }

    fn handle(
        &self,
        record: NativeActionRecord,
        prompter: Arc<dyn NativeLocalActionPrompter>,
    ) -> Result<(), ()> {
        if matches!(record, NativeActionRecord::PackagedStartup { .. }) {
            return self.handle_packaged_startup(record);
        }
        if record.fence().generation != self.launch_generation {
            self.revoke_all();
            return Err(());
        }
        if !self.state.lock().map_err(|_| ())?.startup_attested {
            self.write_denial(&record);
            return Ok(());
        }
        if matches!(record, NativeActionRecord::Revoke { .. }) {
            if !validate_native_action(&record, self.actual_pid, (self.now)()) {
                self.revoke_all();
                return Err(());
            }
            let fence = record.fence();
            let mut state = self.state.lock().map_err(|_| ())?;
            let matching = state
                .pending
                .as_ref()
                .map(|pending| pending.request.fence() == fence)
                .unwrap_or(false);
            if matching {
                let token = state.pending.take().map(|pending| pending.token);
                drop(state);
                if let Some(token) = token {
                    self.finish_deadline_worker(token, false);
                }
                return Ok(());
            }
            state.active = false;
            state.pending.take();
            drop(state);
            self.finish_any_deadline_worker();
            return Err(());
        }
        if !validate_native_action(&record, self.actual_pid, (self.now)()) {
            self.write_denial(&record);
            return Ok(());
        }

        let request_key = record.fence().request_id;
        let token = {
            let mut state = self.state.lock().map_err(|_| ())?;
            if !state.active {
                return Err(());
            }
            if state.seen.contains(&request_key) {
                drop(state);
                self.write_denial(&record);
                return Ok(());
            }
            if state.seen.len() >= NATIVE_ACTION_HISTORY_CAP {
                state.active = false;
                state.pending.take();
                drop(state);
                self.finish_any_deadline_worker();
                return Err(());
            }
            if state.pending.is_some() {
                drop(state);
                self.write_denial(&record);
                return Ok(());
            }
            state.seen.insert(request_key);
            state.next_token = state.next_token.wrapping_add(1);
            let token = state.next_token;
            state.pending = Some(PendingNativeAction {
                token,
                request: record.clone(),
            });
            token
        };

        if !self.permit_fits(&record) {
            if let Ok(mut state) = self.state.lock() {
                if state.pending.as_ref().map(|pending| pending.token) == Some(token) {
                    state.pending.take();
                }
            }
            self.write_denial(&record);
            return Ok(());
        }

        let deadline_at = record.fence().deadline_at;
        if self.start_deadline_worker(token, deadline_at).is_err() {
            if let Ok(mut state) = self.state.lock() {
                state.active = false;
                if state.pending.as_ref().map(|pending| pending.token) == Some(token) {
                    state.pending.take();
                }
            }
            self.finish_any_deadline_worker();
            return Err(());
        }

        let still_pending = self
            .state
            .lock()
            .map(|state| {
                state.active
                    && state.pending.as_ref().map(|pending| pending.token) == Some(token)
                    && (self.now)() < deadline_at
            })
            .unwrap_or(false);
        if !still_pending {
            self.finish_deadline_worker(token, false);
            self.settle(token, false, false);
            return Ok(());
        }

        let callback_coordinator = self.clone();
        let presentation = record.presentation().ok_or(())?;
        prompter.show(
            presentation,
            Box::new(move |accepted| callback_coordinator.settle(token, accepted, false)),
        );
        Ok(())
    }

    fn codex_presentation_authorization(
        &self,
        child_generation: u64,
        deadline_at: u64,
    ) -> CodexPresentationAuthorization {
        let coordinator = self.clone();
        CodexPresentationAuthorization::new(move || {
            child_generation == coordinator.launch_generation
                && (coordinator.now)() < deadline_at
                && coordinator
                    .state
                    .lock()
                    .map(|state| state.active)
                    .unwrap_or(false)
        })
    }

    fn start_deadline_worker(&self, token: u64, deadline_at: u64) -> Result<(), ()> {
        let signal = Arc::new((
            Mutex::new(DeadlineWorkerSignal {
                started: false,
                cancelled: false,
            }),
            Condvar::new(),
        ));
        let worker_signal = Arc::clone(&signal);
        let worker_coordinator = self.clone();
        let job: Box<dyn FnOnce() + Send> = Box::new(move || {
            let (lock, wake) = &*worker_signal;
            let Ok(mut state) = lock.lock() else {
                worker_coordinator.fail_deadline_worker(token);
                return;
            };
            while !state.started && !state.cancelled {
                let Ok(next) = wake.wait(state) else {
                    worker_coordinator.fail_deadline_worker(token);
                    return;
                };
                state = next;
            }
            while !state.cancelled {
                let remaining = deadline_at.saturating_sub((worker_coordinator.now)());
                if remaining == 0 {
                    drop(state);
                    worker_coordinator.settle(token, false, true);
                    return;
                }
                let wait = Duration::from_millis(remaining).min(DEADLINE_RECHECK_HORIZON);
                let Ok((next, _)) = wake.wait_timeout(state, wait) else {
                    worker_coordinator.fail_deadline_worker(token);
                    return;
                };
                state = next;
            }
        });
        let handle = (self.deadline_spawner)(job).map_err(|_| ())?;
        {
            let mut current = match self.deadline_worker.lock() {
                Ok(current) => current,
                Err(_) => {
                    if let Ok(mut state) = signal.0.lock() {
                        state.cancelled = true;
                        signal.1.notify_all();
                    }
                    let _ = handle.join();
                    return Err(());
                }
            };
            if current.is_some() {
                if let Ok(mut state) = signal.0.lock() {
                    state.cancelled = true;
                    signal.1.notify_all();
                }
                let _ = handle.join();
                return Err(());
            }
            *current = Some(DeadlineWorker {
                token,
                signal: Arc::clone(&signal),
                handle,
            });
        }
        let mut state = signal.0.lock().map_err(|_| ())?;
        state.started = true;
        signal.1.notify_all();
        Ok(())
    }

    fn fail_deadline_worker(&self, token: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.active = false;
            if state.pending.as_ref().map(|pending| pending.token) == Some(token) {
                state.pending.take();
            }
        }
        self.finish_deadline_worker(token, true);
    }

    fn finish_deadline_worker(&self, token: u64, from_deadline_worker: bool) {
        let worker = self.deadline_worker.lock().ok().and_then(|mut current| {
            if current.as_ref().map(|worker| worker.token) == Some(token) {
                current.take()
            } else {
                None
            }
        });
        let Some(worker) = worker else { return };
        if let Ok(mut state) = worker.signal.0.lock() {
            state.cancelled = true;
            worker.signal.1.notify_all();
        }
        if !from_deadline_worker {
            let _ = worker.handle.join();
        }
    }

    fn finish_any_deadline_worker(&self) {
        let token = self
            .deadline_worker
            .lock()
            .ok()
            .and_then(|current| current.as_ref().map(|worker| worker.token));
        if let Some(token) = token {
            self.finish_deadline_worker(token, false);
        }
    }

    fn permit_fits(&self, request: &NativeActionRecord) -> bool {
        serde_json::to_vec(&serde_json::json!({
            "kind": "permit",
            "request": request,
            "nonce": "AAAAAAAAAAAAAAAAAAAAAA",
        }))
        .map(|bytes| bytes.len() <= engine::MAX_PRIVATE_PAYLOAD)
        .unwrap_or(false)
    }

    fn write_denial(&self, request: &NativeActionRecord) {
        let fence = request.fence();
        let value = serde_json::json!({
            "kind": "denied", "requestId": fence.request_id, "sessionId": fence.session_id,
            "childPid": fence.child_pid, "revision": fence.revision,
            "generation": fence.generation, "deadlineAt": fence.deadline_at,
        });
        let wrote = serde_json::to_vec(&value)
            .ok()
            .filter(|bytes| bytes.len() <= engine::MAX_PRIVATE_PAYLOAD)
            .map(|bytes| self.control.write_control(&bytes))
            .unwrap_or(false);
        if !wrote {
            self.revoke_all();
        }
    }

    fn settle(&self, token: u64, accepted: bool, deadline: bool) {
        let request = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let matches = state
                .pending
                .as_ref()
                .map(|pending| pending.token == token)
                .unwrap_or(false);
            if !state.active || !matches {
                return;
            }
            let expired =
                (self.now)() >= state.pending.as_ref().unwrap().request.fence().deadline_at;
            if deadline && !expired {
                return;
            }
            state.pending.take().unwrap().request
        };
        self.finish_deadline_worker(token, deadline);
        let fence = request.fence();
        let value = if accepted && !deadline && (self.now)() < fence.deadline_at {
            let mut random = [0_u8; 16];
            if getrandom::fill(&mut random).is_ok() {
                serde_json::json!({ "kind": "permit", "request": request, "nonce": base64url_nonce(random) })
            } else {
                serde_json::json!({
                    "kind": "denied", "requestId": fence.request_id, "sessionId": fence.session_id,
                    "childPid": fence.child_pid, "revision": fence.revision,
                    "generation": fence.generation, "deadlineAt": fence.deadline_at,
                })
            }
        } else {
            serde_json::json!({
                "kind": "denied", "requestId": fence.request_id, "sessionId": fence.session_id,
                "childPid": fence.child_pid, "revision": fence.revision,
                "generation": fence.generation, "deadlineAt": fence.deadline_at,
            })
        };
        let Ok(bytes) = serde_json::to_vec(&value) else {
            self.revoke_all();
            return;
        };
        if !self.control.write_control(&bytes) {
            self.revoke_all();
        }
    }

    fn revoke_all(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.active = false;
            state.pending.take();
        }
        self.finish_any_deadline_worker();
    }
}

struct NativeActionRuntime {
    coordinator: NativeActionCoordinator,
    activation: Arc<(Mutex<bool>, Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl NativeActionRuntime {
    #[cfg(test)]
    fn new(
        reader: NativeActionReader,
        coordinator: NativeActionCoordinator,
        prompter: Arc<dyn NativeLocalActionPrompter>,
    ) -> Self {
        Self::new_with_codex(
            reader,
            coordinator,
            prompter,
            Arc::new(RejectingCodexNativeLoginPresenter),
        )
    }

    fn new_with_codex(
        mut reader: NativeActionReader,
        coordinator: NativeActionCoordinator,
        prompter: Arc<dyn NativeLocalActionPrompter>,
        codex_presenter: Arc<dyn CodexNativeLoginPresenter>,
    ) -> Self {
        let activation = Arc::new((Mutex::new(false), Condvar::new()));
        let thread_activation = Arc::clone(&activation);
        let thread_coordinator = coordinator.clone();
        let thread = std::thread::spawn(move || {
            let (lock, signal) = &*thread_activation;
            let Ok(mut active) = lock.lock() else {
                thread_coordinator.revoke_all();
                return;
            };
            while !*active {
                let Ok(next) = signal.wait(active) else {
                    thread_coordinator.revoke_all();
                    return;
                };
                active = next;
            }
            drop(active);
            let mut codex_state = CodexNativeActionState::default();
            loop {
                let bytes = match reader.read_frame() {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        codex_state.revoke_all();
                        thread_coordinator.revoke_all();
                        break;
                    }
                };
                if let Ok(record) = parse_codex_native_action(
                    &bytes,
                    thread_coordinator.launch_generation,
                    (thread_coordinator.now)(),
                ) {
                    let authorization = thread_coordinator.codex_presentation_authorization(
                        record.child_generation(),
                        record.deadline_at(),
                    );
                    if handle_codex_native_action(
                        &mut codex_state,
                        record,
                        Arc::clone(&codex_presenter),
                        Arc::clone(&thread_coordinator.control),
                        authorization,
                    )
                    .is_err()
                    {
                        codex_state.revoke_all();
                        thread_coordinator.revoke_all();
                        break;
                    }
                    continue;
                }
                let record = match serde_json::from_slice::<NativeActionRecord>(&bytes) {
                    Ok(record) => record,
                    Err(_) => {
                        codex_state.revoke_all();
                        thread_coordinator.revoke_all();
                        break;
                    }
                };
                if thread_coordinator
                    .handle(record, Arc::clone(&prompter))
                    .is_err()
                {
                    codex_state.revoke_all();
                    break;
                }
            }
        });
        Self {
            coordinator,
            activation,
            thread: Some(thread),
        }
    }

    fn activate(&self) {
        let (lock, signal) = &*self.activation;
        if let Ok(mut active) = lock.lock() {
            *active = true;
            signal.notify_all();
        }
    }

    fn revoke_all(&self) {
        self.coordinator.revoke_all();
    }

    fn wait(&mut self, grace: Duration) -> bool {
        let deadline = std::time::Instant::now() + grace;
        while self
            .thread
            .as_ref()
            .map(|thread| !thread.is_finished())
            .unwrap_or(false)
        {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        self.thread
            .take()
            .map(|thread| thread.join().is_ok())
            .unwrap_or(true)
    }
}

impl Drop for NativeActionRuntime {
    fn drop(&mut self) {
        self.revoke_all();
        let (lock, signal) = &*self.activation;
        if let Ok(mut active) = lock.lock() {
            *active = true;
            signal.notify_all();
        }
    }
}

fn publish_stdout_lines(state: &Sidecar, generation: u64, pending: &mut Vec<u8>, bytes: &[u8]) {
    pending.extend_from_slice(bytes);
    while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
        let mut line = pending.drain(..=newline).collect::<Vec<_>>();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        state.publish(
            generation,
            EngineMessage::Frame {
                line: String::from_utf8_lossy(&line).into_owned(),
            },
        );
    }
}

async fn dispatch_lifecycle_off_main<F, T>(job: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn engine_start(
    app: AppHandle,
    on_message: Channel<EngineMessage>,
) -> Result<EngineInfo, ShellError> {
    dispatch_lifecycle_off_main(move || engine_start_blocking(app, on_message))
        .await
        .map_err(|detail| ShellError::from(EngineError::Io(detail)))?
}

fn engine_start_blocking(
    app: AppHandle,
    on_message: Channel<EngineMessage>,
) -> Result<EngineInfo, ShellError> {
    let state = sidecar().clone();
    let spawn_guard = acquire_process_spawn_guard();
    state
        .shutdown_under_guard(&spawn_guard)
        .map_err(|detail| ShellError::from(EngineError::Io(detail)))?;
    let launch = plan_launch(&app)?;
    // Both pipes and all four CLOEXEC flags exist before Command does.
    let mut channels = create_native_sidecar_channels(&spawn_guard)
        .map_err(|error| EngineError::Spawn(error.to_string()))?;
    let mut command = Command::new(&launch.node);
    command
        .arg(&launch.script)
        .current_dir(&launch.cwd)
        .env("HOME", launch.home.to_string_lossy().to_string())
        .env("ORCODE_GUI_SHELL", "tauri")
        .env("ORCODE_GUI_EXECUTION_MODE", "local-interactive-owner")
        .env("FORCE_COLOR", "0")
        .env("NO_COLOR", "1");
    channels
        .prepare_command(&mut command)
        .map_err(|error| EngineError::Spawn(error.to_string()))?;
    let generation = state.lifecycle.begin_start(&spawn_guard);
    let raw = match spawn_raw_engine_after(&spawn_guard, command, || channels.parent_after_spawn())
    {
        Ok(raw) => raw,
        Err(error) => {
            state.lifecycle.finish_stop(&spawn_guard);
            return Err(error.into());
        }
    };
    let pid = raw.pid();
    let (action_reader, control_writer) = match channels.into_parent_ends() {
        Ok(ends) => ends,
        Err(error) => {
            drop(raw);
            state.lifecycle.finish_stop(&spawn_guard);
            return Err(EngineError::Spawn(error.to_string()).into());
        }
    };
    let (pipe, receiver, ownership, drain) = raw.into_parts();
    // Classification state belongs to this generation's pump. A successor
    // receives a different allocation, so an old event cannot repopulate a
    // tail that the successor reset.
    let stderr = GenerationStderr::fresh();
    let info = EngineInfo {
        node: launch.node.display().to_string(),
        script: launch.script.display().to_string(),
        workspace: launch.cwd.display().to_string(),
        home: launch.home.display().to_string(),
        real_home: launch.real_home,
        pid,
    };
    let coordinator = NativeActionCoordinator::new(
        pid,
        generation,
        Arc::new(GenerationBoundControlWriter {
            sidecar: Arc::clone(&state),
            generation,
        }),
        unix_millis,
    );
    let native_actions = NativeActionRuntime::new_with_codex(
        action_reader,
        coordinator,
        Arc::new(TauriNativeLocalActionPrompter { app: app.clone() }),
        Arc::new(TauriCodexNativeLoginPresenter { app: app.clone() }),
    );
    let live = LiveChild {
        pipe,
        ownership,
        drain,
        native_actions,
    };
    if state
        .lifecycle
        .install_live(&spawn_guard, generation, live, on_message, control_writer)
        .is_err()
    {
        state.lifecycle.finish_stop(&spawn_guard);
        return Err(EngineError::Spawn(
            "the launch generation was revoked before installation".into(),
        )
        .into());
    }
    state.lifecycle.with_live(|live, phase| {
        if phase == LifecyclePhase::Live {
            if let Some(live) = live {
                live.native_actions.activate();
            }
        }
    });
    let reader_state = Arc::clone(&state);
    let reader_stderr = stderr.clone();
    std::thread::spawn(move || {
        let mut stdout_pending = Vec::new();
        loop {
            let event = match receiver.recv_timeout(engine::SHUTDOWN_POLL) {
                Ok(event) => event,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            };
            match event {
                RawEngineEvent::Stdout(bytes) => {
                    publish_stdout_lines(&reader_state, generation, &mut stdout_pending, &bytes);
                }
                RawEngineEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    reader_stderr.push(&text);
                    diagnostic(&format!("orcode-engine: {text}"));
                }
                RawEngineEvent::Error => {
                    diagnostic("orcode-gui: an engine output pipe failed.\n");
                    reader_state.publish(
                        generation,
                        EngineMessage::Failed {
                            code: "engine-io".into(),
                        },
                    );
                }
                RawEngineEvent::Terminated { code, signal } => {
                    if !stdout_pending.is_empty() {
                        let bytes = std::mem::take(&mut stdout_pending);
                        publish_stdout_lines(
                            &reader_state,
                            generation,
                            &mut stdout_pending,
                            &[bytes, b"\n".to_vec()].concat(),
                        );
                    }
                    let cause = reader_stderr.classify();
                    let ended = reader_state
                        .lifecycle
                        .terminate_current(generation, |channel| {
                            let _ = channel.send(EngineMessage::Exited {
                                code,
                                signal,
                                cause,
                            });
                        });
                    drop(ended);
                    receiver.acknowledge_terminated();
                    break;
                }
            }
        }
    });
    drop(spawn_guard);
    Ok(info)
}

/// One protocol line, client → engine. The shell adds the newline and
/// nothing else; it does not read, rewrite or validate the frame.
#[tauri::command]
async fn engine_send(line: String) -> Result<(), ShellError> {
    dispatch_lifecycle_off_main(move || engine_send_blocking(line))
        .await
        .map_err(|detail| ShellError::from(EngineError::Io(detail)))?
}

fn engine_send_blocking(line: String) -> Result<(), ShellError> {
    let state = sidecar().clone();
    state.lifecycle.with_live(|live, phase| {
        if phase != LifecyclePhase::Live {
            return Err(ShellError::from(EngineError::NotRunning));
        }
        live.ok_or_else(|| ShellError::from(EngineError::NotRunning))?
            .pipe
            .write(&line)
            .map_err(shell_error_for_pipe)
    })
}

/// F5(a): an engine that stopped reading is a STATE, and it gets a sentence.
///
/// Before this, the write simply blocked once the kernel's 64 KiB stdin
/// buffer filled, which on the shutdown path meant a quit held open by a
/// wedged engine. Now the backlog is bounded, the wait is bounded, and the
/// window is told which of the two happened — in its own words, never the
/// operating system's.
fn shell_error_for_pipe(error: engine::PipeError) -> ShellError {
    match error {
        engine::PipeError::Backlogged => ShellError {
            code: "engine-not-reading".into(),
            message: "The engine has stopped reading its input.".into(),
            hint: Some("Restart the engine to continue.".into()),
        },
        engine::PipeError::Stalled => ShellError {
            code: "engine-stalled".into(),
            message: "The engine did not accept that message.".into(),
            hint: Some("Restart the engine to continue.".into()),
        },
        engine::PipeError::Gone => ShellError::from(EngineError::NotRunning),
        engine::PipeError::Failed(detail) => ShellError::from(EngineError::Io(detail)),
    }
}

#[tauri::command]
async fn project_choose(app:AppHandle)->Result<Option<String>,String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Projektordner öffnen").blocking_pick_folder()
            .map(|selected| selected.into_path().map(|path|path.to_string_lossy().into_owned())
                .map_err(|_|"Der ausgewählte Ordner ist kein lokaler Pfad.".to_string())).transpose()
    }).await.map_err(|_|"Der Ordnerdialog konnte nicht geöffnet werden.".to_string())?
}

#[tauri::command]
async fn engine_stop() -> Result<String, String> {
    dispatch_lifecycle_off_main(engine_stop_blocking).await?
}

fn engine_stop_blocking() -> Result<String, String> {
    Ok(match sidecar().shutdown()? {
        None => "not-running".to_string(),
        Some(ShutdownOutcome::EndedOnRequest) => "ended".to_string(),
        Some(ShutdownOutcome::Killed) => "killed".to_string(),
        Some(ShutdownOutcome::KillFailed(message)) => format!("kill-failed: {message}"),
    })
}

#[cfg(test)]
mod task_4a_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Barrier;

    static SCHEDULER_LIVE: AtomicUsize = AtomicUsize::new(0);
    static SCHEDULER_MAX: AtomicUsize = AtomicUsize::new(0);
    static START_REVOKE_RACE_LIVE: AtomicUsize = AtomicUsize::new(0);

    #[derive(Clone)]
    struct StartRevokeRaceBarriers {
        spawned: Arc<Barrier>,
        release: Arc<Barrier>,
    }

    static START_REVOKE_RACE_BARRIERS: OnceLock<Mutex<Option<StartRevokeRaceBarriers>>> =
        OnceLock::new();

    fn counting_scheduler_spawn(
        job: Box<dyn FnOnce() + Send>,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        std::thread::Builder::new()
            .name("task-4a-counting-deadline".into())
            .spawn(move || {
                let live = SCHEDULER_LIVE.fetch_add(1, Ordering::SeqCst) + 1;
                SCHEDULER_MAX.fetch_max(live, Ordering::SeqCst);
                job();
                SCHEDULER_LIVE.fetch_sub(1, Ordering::SeqCst);
            })
    }

    fn failing_scheduler_spawn(
        _job: Box<dyn FnOnce() + Send>,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        Err(std::io::Error::other("local scheduler spawn failure"))
    }

    fn barrier_scheduler_spawn(
        job: Box<dyn FnOnce() + Send>,
    ) -> std::io::Result<std::thread::JoinHandle<()>> {
        let barriers = START_REVOKE_RACE_BARRIERS
            .get()
            .and_then(|slot| slot.lock().ok()?.clone())
            .ok_or_else(|| std::io::Error::other("race barriers are not installed"))?;
        let worker_barriers = barriers.clone();
        let handle = std::thread::Builder::new()
            .name("task-4a-start-revoke-race".into())
            .spawn(move || {
                START_REVOKE_RACE_LIVE.fetch_add(1, Ordering::SeqCst);
                worker_barriers.spawned.wait();
                job();
                START_REVOKE_RACE_LIVE.fetch_sub(1, Ordering::SeqCst);
            })?;
        barriers.spawned.wait();
        barriers.release.wait();
        Ok(handle)
    }

    fn wait_for_scheduler_count(expected: usize) {
        let deadline = std::time::Instant::now() + Duration::from_millis(250);
        while SCHEDULER_LIVE.load(Ordering::SeqCst) != expected
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(SCHEDULER_LIVE.load(Ordering::SeqCst), expected);
    }

    #[derive(Default)]
    struct FakePrompt {
        presentations: Mutex<Vec<NativeLocalActionPresentation>>,
        callback: Mutex<Option<Box<dyn FnOnce(bool) + Send>>>,
    }

    impl NativeLocalActionPrompter for FakePrompt {
        fn show(
            &self,
            presentation: NativeLocalActionPresentation,
            callback: Box<dyn FnOnce(bool) + Send>,
        ) {
            self.presentations.lock().unwrap().push(presentation);
            *self.callback.lock().unwrap() = Some(callback);
        }
    }

    #[derive(Default)]
    struct FakeControl {
        records: Mutex<Vec<Vec<u8>>>,
        writes: AtomicUsize,
    }

    impl PrivateControlSink for FakeControl {
        fn write_control(&self, bytes: &[u8]) -> bool {
            self.writes.fetch_add(1, Ordering::SeqCst);
            self.records.lock().unwrap().push(bytes.to_vec());
            true
        }
    }

    fn turn_json(request_id: &str, child_pid: u32, deadline_at: u64) -> String {
        format!(
            r#"{{"kind":"kimi-turn","requestId":"{request_id}","sessionId":"session","childPid":{child_pid},"runId":"run","route":{{"version":1,"backendId":"kimi-code","accountFingerprint":"account","billingRealm":"kimi-code-membership-provider-managed-overage","requestedModelId":"k3","canonicalModelId":"k3","resolutionState":"resolved"}},"requestDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revision":8,"generation":5,"deadlineAt":{deadline_at}}}"#
        )
    }

    #[cfg(unix)]
    #[test]
    fn verified_packaged_startup_writes_one_bound_attestation_and_replay_revokes() {
        let pid = 4242_u32;
        let control = Arc::new(FakeControl::default());
        let verified = crate::packaged_app_trust::verified_packaged_app_fixture(
            "/Volumes/Orcode/Orcode.app/Contents/MacOS/orcode-gui",
            7,
            8,
            9,
            "ABCDE12345",
            [0xbb; 32],
            [0xaa; 32],
        )
        .expect("validated packaged fixture");
        let coordinator = NativeActionCoordinator::new_with_verified_packaged_app(
            pid,
            41,
            verified,
            control.clone(),
            || 1_000,
        );
        let source = format!(
            r#"{{"kind":"packaged-startup","requestId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","challenge":"BBBBBBBBBBBBBBBBBBBBBB","sessionId":"session","childPid":{pid},"actionChannelId":"fd:198","controlChannelId":"fd:199"}}"#
        );
        let startup = parse_native_action(source.as_bytes(), pid, 1_000).unwrap();
        coordinator
            .handle(startup.clone(), Arc::new(FakePrompt::default()))
            .unwrap();
        let records = control.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        let value: serde_json::Value = serde_json::from_slice(&records[0]).unwrap();
        assert_eq!(value["kind"], "packaged-attestation");
        assert_eq!(value["generation"], 41);
        assert_eq!(value["executableDevice"], 7);
        assert_eq!(value["policySha256"], "aa".repeat(32));
        assert_eq!(value["executableSha256"], "bb".repeat(32));
        drop(records);
        assert!(coordinator
            .handle(startup, Arc::new(FakePrompt::default()))
            .is_err());
        assert!(!coordinator.state.lock().unwrap().active);
        assert_eq!(control.writes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn missing_packaged_verification_and_wrong_generation_are_inert() {
        let pid = 4242_u32;
        let control = Arc::new(FakeControl::default());
        let unverified = NativeActionCoordinator::new(pid, 5, control.clone(), || 1_000);
        assert!(!unverified.state.lock().unwrap().active);
        let startup = parse_native_action(
            format!(r#"{{"kind":"packaged-startup","requestId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","challenge":"BBBBBBBBBBBBBBBBBBBBBB","sessionId":"session","childPid":{pid},"actionChannelId":"fd:198","controlChannelId":"fd:199"}}"#).as_bytes(),
            pid,
            1_000,
        ).unwrap();
        assert!(unverified
            .handle(startup, Arc::new(FakePrompt::default()))
            .is_err());
        assert_eq!(control.writes.load(Ordering::SeqCst), 0);

        let mismatch_control = Arc::new(FakeControl::default());
        let mismatch = NativeActionCoordinator::new_with_scheduler(
            pid,
            6,
            mismatch_control.clone(),
            || 1_000,
            spawn_deadline_thread,
        );
        let prompt = Arc::new(FakePrompt::default());
        let action = parse_native_action(
            turn_json("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", pid, 2_000).as_bytes(),
            pid,
            1_000,
        )
        .unwrap();
        assert!(mismatch.handle(action, prompt.clone()).is_err());
        assert!(prompt.presentations.lock().unwrap().is_empty());
        assert_eq!(mismatch_control.writes.load(Ordering::SeqCst), 0);
        assert!(!mismatch.state.lock().unwrap().active);
    }

    #[test]
    fn private_action_parser_is_closed_and_bounds_cross_request_budget() {
        let now = 1_000_u64;
        let pid = 4242_u32;
        let turn = parse_native_action(
            turn_json("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", pid, now + 1_000).as_bytes(),
            pid,
            now,
        )
        .unwrap();
        assert!(matches!(turn, NativeActionRecord::KimiTurn { .. }));
        let setup = format!(
            r#"{{"kind":"kimi-setup","requestId":"IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII","sessionId":"session","childPid":{pid},"setupId":"setup","provider":"kimi-code","operation":"initial-setup","revision":8,"generation":5,"deadlineAt":{}}}"#,
            now + 1_000,
        );
        assert!(matches!(
            parse_native_action(setup.as_bytes(), pid, now).unwrap(),
            NativeActionRecord::KimiSetup { .. }
        ));

        let cross = format!(
            r#"{{"kind":"kimi-cross","requestId":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","sessionId":"session","childPid":{pid},"crossRunId":"cross","lead":{{"version":1,"backendId":"kimi-code","accountFingerprint":"account","billingRealm":"kimi-code-membership-provider-managed-overage","requestedModelId":"k3","canonicalModelId":"k3","resolutionState":"resolved"}},"challenger":{{"version":1,"backendId":"openrouter","accountFingerprint":"other","billingRealm":"openrouter-payg","requestedModelId":"m","canonicalModelId":"m","resolutionState":"resolved"}},"repairBudget":1,"requestBudgetPerStage":100,"revision":8,"generation":5,"deadlineAt":{}}}"#,
            now + 1_000,
        );
        assert!(matches!(
            parse_native_action(cross.as_bytes(), pid, now).unwrap(),
            NativeActionRecord::KimiCross { .. }
        ));
        for invalid in ["0", "101", "1.5", "\"1\""] {
            let changed = cross.replace(
                "\"requestBudgetPerStage\":100",
                &format!("\"requestBudgetPerStage\":{invalid}"),
            );
            assert!(parse_native_action(changed.as_bytes(), pid, now).is_err());
        }
        assert!(parse_native_action(
            turn_json("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", pid + 1, now + 1_000).as_bytes(),
            pid,
            now,
        )
        .is_err());
        assert!(parse_native_action(
            turn_json("DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", pid, now).as_bytes(),
            pid,
            now,
        )
        .is_err());
        let duplicate = turn_json("EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE", pid, now + 1_000).replacen(
            "\"revision\":8",
            "\"revision\":8,\"revision\":9",
            1,
        );
        assert!(parse_native_action(duplicate.as_bytes(), pid, now).is_err());
    }

    #[test]
    fn prompt_is_secretless_and_accept_or_denial_writes_one_exact_control() {
        let now = 1_000_u64;
        let pid = 4242_u32;
        let control = Arc::new(FakeControl::default());
        let coordinator = NativeActionCoordinator::new_with_scheduler(
            pid,
            5,
            control.clone(),
            move || now,
            spawn_deadline_thread,
        );
        let prompt = Arc::new(FakePrompt::default());
        coordinator
            .handle(
                parse_native_action(
                    turn_json("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", pid, now + 1_000).as_bytes(),
                    pid,
                    now,
                )
                .unwrap(),
                prompt.clone(),
            )
            .unwrap();
        assert_eq!(
            prompt.presentations.lock().unwrap().as_slice(),
            &[NativeLocalActionPresentation {
                provider: "Kimi Code",
                purpose: "Nachricht senden",
            },]
        );
        prompt.callback.lock().unwrap().take().unwrap()(true);
        let records = control.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        let value: serde_json::Value = serde_json::from_slice(&records[0]).unwrap();
        assert_eq!(value["kind"], "permit");
        assert_eq!(
            value["request"]["requestId"],
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
        );
        assert_eq!(value["nonce"].as_str().unwrap().len(), 22);
        assert_eq!(value.as_object().unwrap().len(), 3);
        drop(records);

        let denied_control = Arc::new(FakeControl::default());
        let denied = NativeActionCoordinator::new_with_scheduler(
            pid,
            5,
            denied_control.clone(),
            move || now,
            spawn_deadline_thread,
        );
        let denied_prompt = Arc::new(FakePrompt::default());
        denied
            .handle(
                parse_native_action(
                    turn_json("JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ", pid, now + 1_000).as_bytes(),
                    pid,
                    now,
                )
                .unwrap(),
                denied_prompt.clone(),
            )
            .unwrap();
        denied_prompt.callback.lock().unwrap().take().unwrap()(false);
        let records = denied_control.records.lock().unwrap();
        let value: serde_json::Value = serde_json::from_slice(&records[0]).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "kind": "denied",
                "requestId": "JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ",
                "sessionId": "session",
                "childPid": pid,
                "revision": 8,
                "generation": 5,
                "deadlineAt": now + 1_000,
            })
        );
    }

    #[test]
    fn exact_revoke_and_lifecycle_revocation_make_late_dialogs_inert() {
        let now = 1_000_u64;
        let pid = 4242_u32;
        let control = Arc::new(FakeControl::default());
        let coordinator = NativeActionCoordinator::new_with_scheduler(
            pid,
            5,
            control.clone(),
            move || now,
            spawn_deadline_thread,
        );
        let prompt = Arc::new(FakePrompt::default());
        let request_id = "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG";
        coordinator
            .handle(
                parse_native_action(turn_json(request_id, pid, now + 1_000).as_bytes(), pid, now)
                    .unwrap(),
                prompt.clone(),
            )
            .unwrap();
        let revoke = format!(
            r#"{{"kind":"revoke","requestId":"{request_id}","sessionId":"session","childPid":{pid},"revision":8,"generation":5,"deadlineAt":{}}}"#,
            now + 1_000,
        );
        coordinator
            .handle(
                parse_native_action(revoke.as_bytes(), pid, now).unwrap(),
                prompt.clone(),
            )
            .unwrap();
        prompt.callback.lock().unwrap().take().unwrap()(true);
        assert_eq!(control.writes.load(Ordering::SeqCst), 0);

        let next = "HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";
        coordinator
            .handle(
                parse_native_action(turn_json(next, pid, now + 1_000).as_bytes(), pid, now)
                    .unwrap(),
                prompt.clone(),
            )
            .unwrap();
        coordinator.revoke_all();
        prompt.callback.lock().unwrap().take().unwrap()(false);
        assert_eq!(control.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn callback_at_the_absolute_deadline_can_only_deny_once() {
        let pid = 4242_u32;
        let now = Arc::new(AtomicU64::new(1_000));
        let clock = Arc::clone(&now);
        let control = Arc::new(FakeControl::default());
        let coordinator = NativeActionCoordinator::new_with_scheduler(
            pid,
            5,
            control.clone(),
            move || clock.load(Ordering::SeqCst),
            spawn_deadline_thread,
        );
        let prompt = Arc::new(FakePrompt::default());
        coordinator
            .handle(
                parse_native_action(
                    turn_json("KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK", pid, 2_000).as_bytes(),
                    pid,
                    1_000,
                )
                .unwrap(),
                prompt.clone(),
            )
            .unwrap();
        now.store(2_000, Ordering::SeqCst);
        prompt.callback.lock().unwrap().take().unwrap()(true);
        let records = control.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        let value: serde_json::Value = serde_json::from_slice(&records[0]).unwrap();
        assert_eq!(value["kind"], "denied");
        assert!(value.get("nonce").is_none());
        drop(records);

        let timer_now = Arc::new(AtomicU64::new(3_000));
        let timer_clock = Arc::clone(&timer_now);
        let timer_control = Arc::new(FakeControl::default());
        let timer_coordinator = NativeActionCoordinator::new_with_scheduler(
            pid,
            5,
            timer_control.clone(),
            move || timer_clock.load(Ordering::SeqCst),
            spawn_deadline_thread,
        );
        let timer_prompt = Arc::new(FakePrompt::default());
        timer_coordinator
            .handle(
                parse_native_action(
                    turn_json("QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ", pid, 3_010).as_bytes(),
                    pid,
                    3_000,
                )
                .unwrap(),
                timer_prompt.clone(),
            )
            .unwrap();
        timer_now.store(3_010, Ordering::SeqCst);
        let wait_until = std::time::Instant::now() + Duration::from_millis(100);
        while timer_control.writes.load(Ordering::SeqCst) == 0
            && std::time::Instant::now() < wait_until
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(timer_control.writes.load(Ordering::SeqCst), 1);
        timer_prompt.callback.lock().unwrap().take().unwrap()(true);
        assert_eq!(timer_control.writes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn rust_history_cap_revokes_and_stops_all_later_prompt_or_control() {
        let now = 1_000_u64;
        let pid = 4242_u32;
        let control = Arc::new(FakeControl::default());
        let coordinator = NativeActionCoordinator::new_with_scheduler(
            pid,
            5,
            control.clone(),
            move || now,
            spawn_deadline_thread,
        );
        {
            let mut state = coordinator.state.lock().unwrap();
            for index in 0..1_024 {
                state.seen.insert(format!("{index:032}"));
            }
        }
        let prompt = Arc::new(FakePrompt::default());
        let first = parse_native_action(
            turn_json("LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL", pid, now + 1_000).as_bytes(),
            pid,
            now,
        )
        .unwrap();
        assert!(coordinator.handle(first, prompt.clone()).is_err());
        let later = parse_native_action(
            turn_json("MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM", pid, now + 1_000).as_bytes(),
            pid,
            now,
        )
        .unwrap();
        assert!(coordinator.handle(later, prompt.clone()).is_err());
        assert!(prompt.presentations.lock().unwrap().is_empty());
        assert_eq!(control.writes.load(Ordering::SeqCst), 0);
        assert!(!coordinator.state.lock().unwrap().active);
    }

    #[test]
    fn far_future_revoke_and_repeated_settlement_leave_no_deadline_worker() {
        SCHEDULER_LIVE.store(0, Ordering::SeqCst);
        SCHEDULER_MAX.store(0, Ordering::SeqCst);
        let now = 1_000_u64;
        let pid = 4242_u32;
        let control = Arc::new(FakeControl::default());
        let coordinator = NativeActionCoordinator::new_with_scheduler(
            pid,
            5,
            control,
            move || now,
            counting_scheduler_spawn,
        );
        let prompt = Arc::new(FakePrompt::default());
        for index in 0..8 {
            let request_id = format!("N{index:031}");
            let action = parse_native_action(
                turn_json(&request_id, pid, now + 86_400_000).as_bytes(),
                pid,
                now,
            )
            .unwrap();
            coordinator.handle(action.clone(), prompt.clone()).unwrap();
            wait_for_scheduler_count(1);
            if index % 2 == 0 {
                let fence = action.fence();
                let revoke = NativeActionRecord::Revoke {
                    request_id: fence.request_id,
                    session_id: fence.session_id,
                    child_pid: fence.child_pid,
                    revision: fence.revision,
                    generation: fence.generation,
                    deadline_at: fence.deadline_at,
                };
                coordinator.handle(revoke, prompt.clone()).unwrap();
                prompt.callback.lock().unwrap().take();
            } else {
                prompt.callback.lock().unwrap().take().unwrap()(false);
            }
            wait_for_scheduler_count(0);
        }
        coordinator.revoke_all();
        wait_for_scheduler_count(0);
        assert_eq!(SCHEDULER_MAX.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn revoke_between_deadline_spawn_and_registration_cancels_the_worker() {
        START_REVOKE_RACE_LIVE.store(0, Ordering::SeqCst);
        let barriers = StartRevokeRaceBarriers {
            spawned: Arc::new(Barrier::new(3)),
            release: Arc::new(Barrier::new(2)),
        };
        *START_REVOKE_RACE_BARRIERS
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap() = Some(barriers.clone());

        let now = 1_000_u64;
        let pid = 4242_u32;
        let control = Arc::new(FakeControl::default());
        let coordinator = NativeActionCoordinator::new_with_scheduler(
            pid,
            5,
            control.clone(),
            move || now,
            barrier_scheduler_spawn,
        );
        let prompt = Arc::new(FakePrompt::default());
        let action = parse_native_action(
            turn_json("RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR", pid, now + 86_400_000).as_bytes(),
            pid,
            now,
        )
        .unwrap();
        let handle_coordinator = coordinator.clone();
        let handle_prompt = prompt.clone();
        let handle_thread =
            std::thread::spawn(move || handle_coordinator.handle(action, handle_prompt));

        barriers.spawned.wait();
        coordinator.revoke_all();
        barriers.release.wait();
        assert!(handle_thread.join().unwrap().is_ok());

        let registered_after_revoke = coordinator.deadline_worker.lock().unwrap().is_some();
        let live_after_revoke = START_REVOKE_RACE_LIVE.load(Ordering::SeqCst);
        coordinator.revoke_all();
        let deadline = std::time::Instant::now() + Duration::from_millis(250);
        while START_REVOKE_RACE_LIVE.load(Ordering::SeqCst) != 0
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        *START_REVOKE_RACE_BARRIERS.get().unwrap().lock().unwrap() = None;

        assert_eq!((registered_after_revoke, live_after_revoke), (false, 0));
        assert!(!coordinator.state.lock().unwrap().active);
        assert!(prompt.presentations.lock().unwrap().is_empty());
        assert_eq!(control.writes.load(Ordering::SeqCst), 0);
        assert_eq!(START_REVOKE_RACE_LIVE.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn scheduler_spawn_failure_is_fail_closed_before_prompt_or_control() {
        let now = 1_000_u64;
        let pid = 4242_u32;
        let control = Arc::new(FakeControl::default());
        let coordinator = NativeActionCoordinator::new_with_scheduler(
            pid,
            5,
            control.clone(),
            move || now,
            failing_scheduler_spawn,
        );
        let prompt = Arc::new(FakePrompt::default());
        let action = parse_native_action(
            turn_json("OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO", pid, now + 1_000).as_bytes(),
            pid,
            now,
        )
        .unwrap();
        assert!(coordinator.handle(action, prompt.clone()).is_err());
        assert!(prompt.presentations.lock().unwrap().is_empty());
        assert_eq!(control.writes.load(Ordering::SeqCst), 0);
        assert!(!coordinator.state.lock().unwrap().active);
    }

    #[cfg(unix)]
    fn spawn_real_pipe_runtime(
        close_action_fd: bool,
        generation: u64,
    ) -> (
        engine::RawEngine,
        NativeActionRuntime,
        Arc<FakePrompt>,
        Arc<FakeControl>,
    ) {
        let script = r#"
const fs = require('node:fs');
const request = {
  kind: 'kimi-turn', requestId: 'PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP',
  sessionId: 'runtime-session', childPid: process.pid, runId: 'runtime-run',
  route: { version: 1, backendId: 'kimi-code', accountFingerprint: 'account',
    billingRealm: 'kimi-code-membership-provider-managed-overage', requestedModelId: 'k3',
    canonicalModelId: 'k3', resolutionState: 'resolved' },
  requestDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  revision: 8, generation: 5, deadlineAt: Date.now() + 86400000
};
const payload = Buffer.from(JSON.stringify(request));
const frame = Buffer.alloc(5 + payload.length); frame[0] = 0xa1;
frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5); fs.writeSync(198, frame);
if (process.argv[1] === 'close') fs.closeSync(198);
setInterval(() => {}, 1000);
"#
        .replace("generation: 5", &format!("generation: {generation}"));
        let guard = acquire_process_spawn_guard();
        let mut channels = create_native_sidecar_channels(&guard).unwrap();
        let mut command = Command::new("node");
        command
            .arg("-e")
            .arg(script)
            .arg(if close_action_fd { "close" } else { "keep" });
        channels.prepare_command(&mut command).unwrap();
        let raw =
            spawn_raw_engine_after(&guard, command, || channels.parent_after_spawn()).unwrap();
        let pid = raw.pid();
        let (reader, _control_writer) = channels.into_parent_ends().unwrap();
        drop(guard);
        let prompt = Arc::new(FakePrompt::default());
        let control = Arc::new(FakeControl::default());
        let coordinator = NativeActionCoordinator::new_with_scheduler(
            pid,
            generation,
            control.clone(),
            unix_millis,
            spawn_deadline_thread,
        );
        let runtime = NativeActionRuntime::new(reader, coordinator, prompt.clone());
        (raw, runtime, prompt, control)
    }

    #[cfg(unix)]
    fn wait_for_prompt(prompt: &FakePrompt) {
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while prompt.presentations.lock().unwrap().is_empty()
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(prompt.presentations.lock().unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn real_pipe_runtime_gates_activation_and_eof_cannot_cross_replacement() {
        let (old_raw, mut old_runtime, old_prompt, old_control) =
            spawn_real_pipe_runtime(true, 201);
        std::thread::sleep(Duration::from_millis(25));
        assert!(old_prompt.presentations.lock().unwrap().is_empty());
        old_runtime.activate();
        wait_for_prompt(&old_prompt);
        assert!(old_runtime.wait(Duration::from_millis(500)));

        let (successor_raw, mut successor_runtime, successor_prompt, successor_control) =
            spawn_real_pipe_runtime(false, 202);
        successor_runtime.activate();
        wait_for_prompt(&successor_prompt);
        old_prompt.callback.lock().unwrap().take().unwrap()(true);
        assert_eq!(old_control.writes.load(Ordering::SeqCst), 0);
        successor_prompt.callback.lock().unwrap().take().unwrap()(false);
        assert_eq!(successor_control.writes.load(Ordering::SeqCst), 1);

        successor_runtime.revoke_all();
        old_raw.revoke_and_join(Duration::from_secs(2)).unwrap();
        successor_raw
            .revoke_and_join(Duration::from_secs(2))
            .unwrap();
        assert!(successor_runtime.wait(Duration::from_millis(500)));
    }
}

#[cfg(test)]
mod task_1_fix_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Barrier;
    use std::time::Duration;

    #[test]
    fn task_1_fix_old_stderr_is_rejected_after_successor_install() {
        let store = Arc::new(LifecycleStore::<
            u32,
            std::sync::mpsc::SyncSender<Option<String>>,
            (),
        >::new());
        let guard = acquire_process_spawn_guard();
        let old_stderr = GenerationStderr::fresh();
        let (old_public, old_receiver) = std::sync::mpsc::sync_channel(1);
        let old_generation = store.begin_start(&guard);
        store
            .install_live(&guard, old_generation, 11, old_public, ())
            .unwrap();
        drop(guard);

        let paused = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let old_store = Arc::clone(&store);
        let old_paused = Arc::clone(&paused);
        let old_release = Arc::clone(&release);
        let old_handler = std::thread::spawn(move || {
            old_paused.wait();
            old_release.wait();
            old_stderr.push("Error: old-only\n    at old (old.js:1:1)");
            let cause = old_stderr.classify();
            let published = old_store.with_current_public(old_generation, |channel| {
                channel.try_send(cause.clone()).unwrap();
            });
            (published, cause)
        });
        paused.wait();

        let guard = acquire_process_spawn_guard();
        let successor_stderr = GenerationStderr::fresh();
        let (successor_public, successor_receiver) = std::sync::mpsc::sync_channel(1);
        let successor_generation = store.begin_start(&guard);
        store
            .install_live(&guard, successor_generation, 22, successor_public, ())
            .unwrap();
        drop(guard);
        assert_eq!(successor_stderr.classify(), None);

        release.wait();
        let (old_published, old_cause) = old_handler.join().unwrap();
        assert!(!old_published, "old stderr crossed the generation gate");
        assert_eq!(old_cause.as_deref(), Some("engine-crashed"));
        assert_eq!(successor_stderr.classify(), None);
        assert!(old_receiver.try_recv().is_err());
        assert!(store.with_current_public(successor_generation, |channel| {
            channel.try_send(None).unwrap();
        }));
        assert_eq!(
            successor_receiver
                .recv_timeout(Duration::from_secs(1))
                .unwrap(),
            None
        );
    }

    #[test]
    fn task_1_fix_lifecycle_ipc_dispatch_never_runs_inline() {
        let caller = std::thread::current().id();
        let began = Arc::new(AtomicBool::new(false));
        let began_in_job = Arc::clone(&began);
        let future = dispatch_lifecycle_off_main(move || {
            began_in_job.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(40));
            std::thread::current().id()
        });
        assert!(
            !began.load(Ordering::SeqCst),
            "constructing IPC dispatch ran the lifecycle transaction inline"
        );
        let worker = tauri::async_runtime::block_on(future).expect("spawn_blocking join");
        assert_ne!(
            worker, caller,
            "lifecycle work ran on the IPC caller thread"
        );
    }

    #[test]
    fn task_1_fix_engine_send_returns_an_off_main_future() {
        fn assert_future<F: std::future::Future>(_: &F) {}

        let future = engine_send("dispatch-probe".into());
        assert_future(&future);
        let error = tauri::async_runtime::block_on(future).expect_err("no engine is installed");
        assert_eq!(error.code, "engine-not-running");
    }
}

#[cfg(test)]
mod task_3_codex_native_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Default)]
    struct CodexControl {
        records: Mutex<Vec<Vec<u8>>>,
    }

    impl PrivateControlSink for CodexControl {
        fn write_control(&self, bytes: &[u8]) -> bool {
            self.records.lock().unwrap().push(bytes.to_vec());
            true
        }
    }

    #[derive(Default)]
    struct CodexPresenter {
        presentations: Mutex<Vec<CodexNativeLoginPresentation>>,
        calls: AtomicUsize,
        succeeds: bool,
    }

    impl CodexNativeLoginPresenter for CodexPresenter {
        fn present(
            &self,
            presentation: CodexNativeLoginPresentation,
            _authorization: CodexPresentationAuthorization,
        ) -> bool {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.presentations.lock().unwrap().push(presentation);
            self.succeeds
        }
    }

    #[derive(Default)]
    struct DelayedCodexPresenter {
        queued: Mutex<Option<CodexPresentationAuthorization>>,
    }

    impl CodexNativeLoginPresenter for DelayedCodexPresenter {
        fn present(
            &self,
            _presentation: CodexNativeLoginPresentation,
            authorization: CodexPresentationAuthorization,
        ) -> bool {
            *self.queued.lock().unwrap() = Some(authorization);
            false
        }
    }

    fn current_codex_authorization() -> CodexPresentationAuthorization {
        CodexPresentationAuthorization::new(|| true)
    }

    fn browser_json(generation: u64, deadline: u64) -> String {
        let url = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&scope=openid%20profile%20email%20offline_access&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code_challenge_method=S256&id_token_add_organizations=true&codex_cli_simplified_flow=true&state=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&originator=codex_cli_rs";
        format!(
            r#"{{"kind":"codex-browser-login-prepare","requestId":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC","childGeneration":{generation},"loginId":"login-1","authUrl":"{url}","deadlineAt":{deadline}}}"#
        )
    }

    fn browser_prepare_json(generation: u64, deadline: u64) -> String {
        browser_json(generation, deadline)
    }

    #[test]
    fn manufacturer_cli_prepare_is_closed_and_generation_bound() {
        for provider in ["codex", "claude", "kimi"] {
            for action in ["install", "login", "open-external"] {
                let value = serde_json::json!({
                    "kind":"manufacturer-cli-prepare", "requestId":"C".repeat(32),
                    "childGeneration":4, "provider":provider, "action":action, "deadlineAt":2_000
                });
                let bytes = serde_json::to_vec(&value).unwrap();
                assert!(parse_codex_native_action(&bytes, 4, 1_000).is_ok());
                assert!(parse_codex_native_action(&bytes, 5, 1_000).is_err());
                assert!(parse_codex_native_action(&bytes, 4, 2_000).is_err());
                let mut arbitrary = value;
                arbitrary["command"] = serde_json::json!("curl arbitrary | sh");
                assert!(parse_codex_native_action(&serde_json::to_vec(&arbitrary).unwrap(), 4, 1_000).is_err());
            }
        }
    }

    fn codex_decision_json(kind: &str, request_id: &str, generation: u64, deadline: u64) -> String {
        format!(
            r#"{{"kind":"{kind}","requestId":"{request_id}","childGeneration":{generation},"deadlineAt":{deadline}}}"#
        )
    }

    #[test]
    fn codex_prepare_revoked_before_commit_has_zero_presenter_calls() {
        let now = 1_000;
        let control = Arc::new(CodexControl::default());
        let presenter = Arc::new(CodexPresenter {
            succeeds: true,
            ..Default::default()
        });
        let mut state = CodexNativeActionState::default();
        let prepare =
            parse_codex_native_action(browser_prepare_json(4, now + 1_000).as_bytes(), 4, now)
                .unwrap();
        handle_codex_native_action(
            &mut state,
            prepare,
            presenter.clone(),
            control.clone(),
            current_codex_authorization(),
        )
        .unwrap();
        assert_eq!(presenter.calls.load(Ordering::SeqCst), 0);
        assert!(control.records.lock().unwrap().is_empty());

        let revoke = parse_codex_native_action(
            codex_decision_json(
                "codex-native-action-revoke",
                "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                4,
                now + 1_000,
            )
            .as_bytes(),
            4,
            now,
        )
        .unwrap();
        handle_codex_native_action(
            &mut state,
            revoke,
            presenter.clone(),
            control.clone(),
            current_codex_authorization(),
        )
        .unwrap();

        let commit = parse_codex_native_action(
            codex_decision_json(
                "codex-native-action-commit",
                "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                4,
                now + 1_000,
            )
            .as_bytes(),
            4,
            now,
        )
        .unwrap();
        assert!(handle_codex_native_action(
            &mut state,
            commit,
            presenter.clone(),
            control.clone(),
            current_codex_authorization(),
        )
        .is_err());
        assert_eq!(presenter.calls.load(Ordering::SeqCst), 0);
        assert!(control.records.lock().unwrap().is_empty());
    }

    #[test]
    fn codex_matching_commit_presents_exactly_once_and_replay_is_closed() {
        let now = 1_000;
        let control = Arc::new(CodexControl::default());
        let presenter = Arc::new(CodexPresenter {
            succeeds: true,
            ..Default::default()
        });
        let mut state = CodexNativeActionState::default();
        let prepare =
            parse_codex_native_action(browser_prepare_json(4, now + 1_000).as_bytes(), 4, now)
                .unwrap();
        handle_codex_native_action(
            &mut state,
            prepare,
            presenter.clone(),
            control.clone(),
            current_codex_authorization(),
        )
        .unwrap();
        let commit = parse_codex_native_action(
            codex_decision_json(
                "codex-native-action-commit",
                "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                4,
                now + 1_000,
            )
            .as_bytes(),
            4,
            now,
        )
        .unwrap();
        handle_codex_native_action(
            &mut state,
            commit.clone(),
            presenter.clone(),
            control.clone(),
            current_codex_authorization(),
        )
        .unwrap();
        assert_eq!(presenter.calls.load(Ordering::SeqCst), 1);
        assert_eq!(control.records.lock().unwrap().len(), 1);
        assert!(handle_codex_native_action(
            &mut state,
            commit,
            presenter.clone(),
            control,
            current_codex_authorization(),
        )
        .is_err());
        assert_eq!(presenter.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn codex_wrong_or_stale_commit_never_reaches_the_presenter() {
        let now = 1_000;
        for commit in [
            codex_decision_json(
                "codex-native-action-commit",
                "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
                4,
                now + 1_000,
            ),
            codex_decision_json(
                "codex-native-action-commit",
                "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                4,
                now + 999,
            ),
        ] {
            let control = Arc::new(CodexControl::default());
            let presenter = Arc::new(CodexPresenter {
                succeeds: true,
                ..Default::default()
            });
            let mut state = CodexNativeActionState::default();
            let prepare =
                parse_codex_native_action(browser_prepare_json(4, now + 1_000).as_bytes(), 4, now)
                    .unwrap();
            handle_codex_native_action(
                &mut state,
                prepare,
                presenter.clone(),
                control.clone(),
                current_codex_authorization(),
            )
            .unwrap();
            let commit = parse_codex_native_action(commit.as_bytes(), 4, now).unwrap();
            assert!(handle_codex_native_action(
                &mut state,
                commit,
                presenter.clone(),
                control,
                current_codex_authorization(),
            )
            .is_err());
            assert_eq!(presenter.calls.load(Ordering::SeqCst), 0);
        }
        assert!(parse_codex_native_action(
            codex_decision_json(
                "codex-native-action-commit",
                "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                5,
                now + 1_000,
            )
            .as_bytes(),
            4,
            now,
        )
        .is_err());
        assert!(parse_codex_native_action(
            codex_decision_json(
                "codex-native-action-commit",
                "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                4,
                now,
            )
            .as_bytes(),
            4,
            now,
        )
        .is_err());
        let oversized_generation = MAX_SAFE_JSON_INTEGER + 1;
        assert!(parse_codex_native_action(
            codex_decision_json(
                "codex-native-action-commit",
                "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                oversized_generation,
                now + 1_000,
            )
            .as_bytes(),
            oversized_generation,
            now,
        )
        .is_err());
    }

    #[test]
    fn codex_native_parser_revalidates_generation_deadline_and_exact_login_url() {
        let now = 1_000;
        assert!(parse_codex_native_action(browser_json(4, now + 1_000).as_bytes(), 4, now).is_ok());
        let immediate = browser_json(4, now + 1_000)
            .replace("codex-browser-login-prepare", "codex-browser-login");
        assert!(parse_codex_native_action(immediate.as_bytes(), 4, now).is_err());
        assert!(
            parse_codex_native_action(browser_json(5, now + 1_000).as_bytes(), 4, now).is_err()
        );
        assert!(parse_codex_native_action(browser_json(4, now).as_bytes(), 4, now).is_err());
        let wrong_host = browser_json(4, now + 1_000).replace("auth.openai.com", "example.test");
        assert!(parse_codex_native_action(wrong_host.as_bytes(), 4, now).is_err());
        let duplicate = browser_json(4, now + 1_000).replace(
            "\"deadlineAt\":2000",
            "\"deadlineAt\":2000,\"deadlineAt\":2001",
        );
        assert!(parse_codex_native_action(duplicate.as_bytes(), 4, now).is_err());
        for noncanonical in [
            browser_json(4, now + 1_000).replace("https://", "HTTPS://"),
            browser_json(4, now + 1_000).replace("auth.openai.com/", "auth.openai.com:443/"),
            format!("{}&", browser_json(4, now + 1_000)),
            browser_json(4, now + 1_000).replace(
                "http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
                "http%3A%2F%2Flocalhost%3A01455%2Fauth%2Fcallback",
            ),
        ] {
            assert!(parse_codex_native_action(noncanonical.as_bytes(), 4, now).is_err());
        }
        for workspace in [String::new(), "%0A".into(), "A".repeat(257)] {
            let with_workspace = browser_json(4, now + 1_000).replace(
                "&originator=codex_cli_rs",
                &format!("&allowed_workspace_id={workspace}&originator=codex_cli_rs"),
            );
            assert!(parse_codex_native_action(with_workspace.as_bytes(), 4, now).is_err());
        }

        let device = format!(
            r#"{{"kind":"codex-device-login-prepare","requestId":"DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD","childGeneration":4,"loginId":"login-2","verificationUrl":"https://auth.openai.com/codex/device","userCode":"ABCD-EFGH","deadlineAt":{}}}"#,
            now + 1_000,
        );
        assert!(parse_codex_native_action(device.as_bytes(), 4, now).is_ok());
        assert!(parse_codex_native_action(
            device.replace("ABCD-EFGH", "bad-code").as_bytes(),
            4,
            now
        )
        .is_err());
        assert!(parse_codex_native_action(
            device
                .replace("/codex/device", "/codex/device?secret=x")
                .as_bytes(),
            4,
            now
        )
        .is_err());
    }

    #[test]
    fn codex_native_presentation_returns_only_private_presented_or_failed_correlation() {
        let now = 1_000;
        for succeeds in [true, false] {
            let control = Arc::new(CodexControl::default());
            let presenter = Arc::new(CodexPresenter {
                succeeds,
                ..Default::default()
            });
            let prepare =
                parse_codex_native_action(browser_json(4, now + 1_000).as_bytes(), 4, now).unwrap();
            let commit = parse_codex_native_action(
                codex_decision_json(
                    "codex-native-action-commit",
                    "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                    4,
                    now + 1_000,
                )
                .as_bytes(),
                4,
                now,
            )
            .unwrap();
            let mut state = CodexNativeActionState::default();
            handle_codex_native_action(
                &mut state,
                prepare,
                presenter.clone(),
                control.clone(),
                current_codex_authorization(),
            )
            .unwrap();
            assert_eq!(presenter.calls.load(Ordering::SeqCst), 0);
            handle_codex_native_action(
                &mut state,
                commit,
                presenter.clone(),
                control.clone(),
                current_codex_authorization(),
            )
            .unwrap();
            assert_eq!(presenter.calls.load(Ordering::SeqCst), 1);
            let records = control.records.lock().unwrap();
            assert_eq!(records.len(), 1);
            let result: serde_json::Value = serde_json::from_slice(&records[0]).unwrap();
            assert_eq!(result["kind"], "codex-native-action-result");
            assert_eq!(
                result["status"],
                if succeeds { "presented" } else { "failed" }
            );
            assert_eq!(result.as_object().unwrap().len(), 4);
            assert!(!String::from_utf8_lossy(&records[0]).contains("https://"));
        }
    }

    #[test]
    fn timed_out_codex_main_thread_presentation_is_revoked_before_late_execution() {
        let now = 1_000;
        let control = Arc::new(CodexControl::default());
        let presenter = Arc::new(DelayedCodexPresenter::default());
        let lifecycle_current = Arc::new(AtomicBool::new(true));
        let current_for_authorization = Arc::clone(&lifecycle_current);
        let authorization = CodexPresentationAuthorization::new(move || {
            current_for_authorization.load(Ordering::SeqCst)
        });
        let prepare =
            parse_codex_native_action(browser_json(4, now + 1_000).as_bytes(), 4, now).unwrap();
        let commit = parse_codex_native_action(
            codex_decision_json(
                "codex-native-action-commit",
                "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
                4,
                now + 1_000,
            )
            .as_bytes(),
            4,
            now,
        )
        .unwrap();
        let mut state = CodexNativeActionState::default();

        handle_codex_native_action(
            &mut state,
            prepare,
            presenter.clone(),
            control.clone(),
            current_codex_authorization(),
        )
        .unwrap();
        handle_codex_native_action(
            &mut state,
            commit,
            presenter.clone(),
            control,
            authorization,
        )
        .unwrap();
        let queued = presenter.queued.lock().unwrap().take().unwrap();
        let side_effects = AtomicUsize::new(0);
        assert!(!queued.run_if_current(|| {
            side_effects.fetch_add(1, Ordering::SeqCst);
            true
        }));
        assert_eq!(side_effects.load(Ordering::SeqCst), 0);

        lifecycle_current.store(false, Ordering::SeqCst);
        assert!(!queued.is_current());
    }
}

/* =========================================================================
 * The app
 * ====================================================================== */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Even an abort takes the engine with it — the OS closes our end of its
    // stdin pipe, which is the protocol's own EOF trigger — but a panic
    // should still say so, and should still give the engine the polite path
    // while a thread is left to run it.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        diagnostic("orcode-gui: the shell panicked; stopping the engine.\n");
        // `_if_free`: a panic raised inside a lock-held section must not
        // deadlock the hook that is trying to clean up after it.
        sidecar().shutdown_if_free();
        previous_hook(info);
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            engine_start,
            engine_send,
            engine_stop
            ,project_choose
        ])
        .on_window_event(|window, event| {
            // On macOS closing the window is NOT quitting: the process stays
            // in the Dock and neither `ExitRequested` nor `Exit` ever fires,
            // so a sidecar spawned from Rust would simply keep running
            // (G0 §1.4). This app is single-window, so the close IS the quit.
            if let WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        // `.build(..)?.run(..)` rather than `.run(..)`: the scaffold's form
        // takes no event callback, and without one there is nowhere to hang
        // the shutdown at all (G0 A13).
        .build(tauri::generate_context!())
        .expect("the orcode shell could not be built")
        .run(|_app, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                let _ = sidecar().shutdown();
            }
            _ => {}
        });
}
