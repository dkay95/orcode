//! Native Windows adapter for the existing bounded RawEngine lifecycle.
//! Job ownership here is not sandbox, packaged provenance or setup authority.
use super::*;
use crate::platform::windows::job::{EngineJob, NativeProcess, WindowsStdio};
use crate::platform::windows::pipe::{ConnectedPipe, PrivatePipeServer};
use std::sync::atomic::{AtomicBool, Ordering};

impl RawProcessOwnership {
    fn spawn_native(child: NativeProcess, job: EngineJob) -> Self {
        let (commands, incoming) = std::sync::mpsc::sync_channel::<OwnerCommand>(1);
        let exit = Arc::new((Mutex::new(ExitState::default()), Condvar::new()));
        let exit_for_thread = Arc::clone(&exit);
        std::thread::spawn(move || {
            let mut terminal: Option<Option<u32>> = None;
            loop {
                if terminal.is_none() {
                    match child.try_wait() {
                        Ok(Some(code)) => {
                            terminal = Some(Some(code));
                            let _ = job.terminate();
                        }
                        Ok(None) => (),
                        Err(_) => {
                            let _ = job.terminate();
                            if let Ok(Some(code)) = child.try_wait() {
                                terminal = Some(Some(code));
                            }
                        }
                    }
                }
                // Core exit alone is not reap: descendants can still own inherited
                // stdio. Never publish the terminal record before the whole Job is empty.
                if let Some(code) = terminal {
                    if matches!(job.active_processes(), Ok(0)) {
                        let (lock, changed) = &*exit_for_thread;
                        lock.lock().unwrap_or_else(|p| p.into_inner()).record = Some(ExitRecord {
                            code: code.map(|code| code as i32),
                            signal: None,
                        });
                        changed.notify_all();
                        break;
                    }
                    let _ = job.terminate();
                }
                match incoming.try_recv() {
                    Ok(OwnerCommand::Kill(reply)) => {
                        let result = job
                            .terminate()
                            .map(|_| ForceKillResult::Signalled)
                            .map_err(|e| e.to_string());
                        let _ = reply.try_send(result);
                    }
                    Err(
                        std::sync::mpsc::TryRecvError::Empty
                        | std::sync::mpsc::TryRecvError::Disconnected,
                    ) => (),
                }
                std::thread::sleep(RAW_OWNER_POLL);
            }
        });
        Self { commands, exit }
    }
}

struct WindowsInput {
    pipe: ConnectedPipe,
    cancel: Arc<AtomicBool>,
}
impl PipeSink for WindowsInput {
    fn write_line(&mut self, line: &str) -> Result<(), String> {
        let mut bytes = Vec::with_capacity(line.len() + 1);
        bytes.extend_from_slice(line.as_bytes());
        bytes.push(b'\n');
        self.pipe
            .write_all(&bytes, &self.cancel, Instant::now() + PIPE_GRACE)
            .map_err(|error| error.to_string())
    }
}

fn reader(
    pipe: ConnectedPipe,
    stderr: bool,
    sender: std::sync::mpsc::SyncSender<RawEngineEvent>,
    cancel: Arc<AtomicBool>,
    owner_reaped: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut quota = None;
        let mut buffer = [0u8; 4096];
        loop {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            // Observe reap BEFORE peeking. If it flips after this load we read
            // normally once, then snapshot on the next loop. Using a peek made
            // before observing reap could truncate a concurrent final burst.
            let snapshot_reap = quota.is_none() && owner_reaped.load(Ordering::SeqCst);
            let available = match pipe.available_bytes() {
                Ok(Some(available)) => available,
                Ok(None) => {
                    if quota.is_some_and(|left| left > 0) {
                        let _ = send_raw_cancellable(&sender, RawEngineEvent::Error, &cancel);
                    }
                    break;
                }
                Err(_) => {
                    let _ = send_raw_cancellable(&sender, RawEngineEvent::Error, &cancel);
                    break;
                }
            };
            if snapshot_reap {
                quota = Some(available);
            }
            if quota == Some(0) {
                break;
            }
            let count = available.min(buffer.len()).min(quota.unwrap_or(usize::MAX));
            if count == 0 {
                std::thread::sleep(RAW_SEND_POLL);
                continue;
            }
            // Idle peeks are not timed reads: an ordinary quiet period must not
            // poison/retire the pipe. Once bytes exist there is only one reader.
            match pipe.read(
                &mut buffer[..count],
                &cancel,
                Instant::now() + CONTROL_WRITE_GRACE,
            ) {
                Ok(0) | Err(_) => {
                    let _ = send_raw_cancellable(&sender, RawEngineEvent::Error, &cancel);
                    break;
                }
                Ok(count) => {
                    if let Some(left) = &mut quota {
                        *left -= count;
                    }
                    let event = if stderr {
                        RawEngineEvent::Stderr(buffer[..count].to_vec())
                    } else {
                        RawEngineEvent::Stdout(buffer[..count].to_vec())
                    };
                    if !send_raw_cancellable(&sender, event, &cancel) {
                        break;
                    }
                }
            }
        }
        pipe.retire();
    })
}

/// Explicit launch data only; the Command-based Windows API remains fail-closed.
/// before_resume verifies the caller's retained image/runtime binding while the
/// new process is still suspended. This function itself creates no owner proof.
pub fn spawn_native_raw_engine<F>(
    _guard: &ProcessSpawnGuard,
    spec: &NativeWindowsLaunchSpec,
    before_resume: F,
) -> Result<RawEngine, EngineError>
where
    F: FnOnce(&NativeProcess, &EngineJob) -> Result<(), EngineError>,
{
    let io_error = |error: std::io::Error| EngineError::Spawn(error.to_string());
    let (child_in, stdin) = PrivatePipeServer::new()
        .and_then(|pipe| pipe.child_stdio(true))
        .map_err(io_error)?;
    let (child_out, stdout) = PrivatePipeServer::new()
        .and_then(|pipe| pipe.child_stdio(false))
        .map_err(io_error)?;
    let (child_err, stderr) = PrivatePipeServer::new()
        .and_then(|pipe| pipe.child_stdio(false))
        .map_err(io_error)?;
    let stdio = WindowsStdio::new(child_in, child_out, child_err).map_err(io_error)?;
    let job = EngineJob::new().map_err(io_error)?;
    let mut child = job.create_suspended(spec, &stdio).map_err(io_error)?;
    before_resume(&child, &job)?; // NativeProcess Drop kills/reaps on refusal.
    let pid = child.identity().pid;
    drop(stdio); // parent owns no child-side handle after this boundary.
    child.resume().map_err(io_error)?;
    let ownership = RawProcessOwnership::spawn_native(child, job);
    let cancel = Arc::new(AtomicBool::new(false));
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
    let owner_reaped = Arc::new(AtomicBool::new(false));
    let stdout_thread = reader(
        stdout,
        false,
        sender.clone(),
        Arc::clone(&cancel),
        Arc::clone(&owner_reaped),
    );
    let stderr_thread = reader(
        stderr,
        true,
        sender.clone(),
        Arc::clone(&cancel),
        Arc::clone(&owner_reaped),
    );
    let stdin = ChildPipe::spawn(WindowsInput {
        pipe: stdin,
        cancel: Arc::clone(&cancel),
    });
    let owner_for_drain = ownership.clone();
    std::thread::spawn(move || {
        let record = owner_for_drain.wait_exit();
        owner_reaped.store(true, Ordering::SeqCst);
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
        pipe: Some(stdin),
        receiver: Some(receiver),
        ownership,
        drain,
        detached: false,
    })
}
