//! Local-only private Named Pipes with explicit owner DACL and cancellable overlapped I/O.
//! A connection is not authority: native_owner must bind the actual helper and Core first.

use super::identity::{capture_identity, checked_handle, RetainedProcess};
use super::job::EngineJob;
use std::io;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Instant;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::{Authorization::*, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::{CreateEventW, GetCurrentProcess, WaitForSingleObject};
use windows_sys::Win32::System::IO::*;

fn wide(value: &str) -> io::Result<Vec<u16>> {
    if value.contains('\0') {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded-nul"));
    }
    Ok(value.encode_utf16().chain(Some(0)).collect())
}

pub struct PrivatePipeServer {
    handle: OwnedHandle,
    name: String,
}

impl PrivatePipeServer {
    pub fn new() -> io::Result<Self> {
        let owner = capture_identity(unsafe { GetCurrentProcess() })?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(io::Error::other)?;
        let name = format!(
            "\\\\.\\pipe\\orcode-private-{:032x}",
            u128::from_le_bytes(random)
        );
        let name_wide = wide(&name)?;
        let dacl = wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{})", owner.user_sid))?;
        let mut descriptor = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                dacl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let raw = unsafe {
            CreateNamedPipeW(
                name_wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                4101,
                4101,
                500,
                &attributes,
            )
        };
        // Preserve the create error across LocalFree.
        let handle = checked_handle(raw);
        unsafe {
            LocalFree(descriptor);
        }
        Ok(Self {
            handle: handle?,
            name,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// These clients are opened by the shell before spawn. Their connection PID is
    /// NOT a child/owner attestation; only the exact inherited handle list uses them.
    pub(crate) fn child_stdio(self, child_reads: bool) -> io::Result<(OwnedHandle, ConnectedPipe)> {
        let name = wide(&self.name)?;
        let child = checked_handle(unsafe {
            CreateFileW(
                name.as_ptr(),
                if child_reads {
                    GENERIC_READ
                } else {
                    GENERIC_WRITE
                },
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS,
                std::ptr::null_mut(),
            )
        })?;
        let cancel = AtomicBool::new(false);
        let server = self.accept(&cancel, Instant::now() + std::time::Duration::from_secs(1))?;
        Ok((child, server))
    }

    pub fn accept(self, cancel: &AtomicBool, deadline: Instant) -> io::Result<ConnectedPipe> {
        let mut operation = Operation::new(&self.handle, None)?;
        operation.check_before_start(cancel, deadline)?;
        let connected =
            unsafe { ConnectNamedPipe(self.handle.as_raw_handle(), operation.pointer()) };
        if connected == 0 {
            match unsafe { GetLastError() } {
                ERROR_PIPE_CONNECTED => {}
                ERROR_IO_PENDING => {
                    operation.pending = true;
                    operation.complete(cancel, deadline)?;
                }
                _ => return Err(io::Error::last_os_error()),
            }
        }
        operation.check_before_start(cancel, deadline)?;
        drop(operation);
        Ok(ConnectedPipe::new(self.handle))
    }
}

pub fn connect_owner(name: &str, expected_owner: &RetainedProcess) -> io::Result<ConnectedPipe> {
    if name
        .strip_prefix("\\\\.\\pipe\\orcode-private-")
        .is_none_or(|suffix| {
            suffix.len() != 32
                || !suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private-pipe-name-invalid",
        ));
    }
    let name = wide(name)?;
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            std::ptr::null_mut(),
        )
    };
    let handle = checked_handle(raw)?;
    let mut actual_pid = 0;
    if unsafe { GetNamedPipeServerProcessId(handle.as_raw_handle(), &mut actual_pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    expected_owner.revalidate()?;
    if actual_pid != expected_owner.identity().pid
        || capture_identity(unsafe { GetCurrentProcess() })?.user_sid
            != expected_owner.identity().user_sid
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "private-pipe-owner-mismatch",
        ));
    }
    Ok(ConnectedPipe::new(handle))
}

pub struct ConnectedPipe {
    handle: OwnedHandle,
    retired: AtomicBool,
    reader: Mutex<()>,
    writer: Mutex<()>,
    submission: Mutex<()>,
    #[cfg(test)]
    before_submit: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl ConnectedPipe {
    fn new(handle: OwnedHandle) -> Self {
        Self {
            handle,
            retired: AtomicBool::new(false),
            reader: Mutex::new(()),
            writer: Mutex::new(()),
            submission: Mutex::new(()),
            #[cfg(test)]
            before_submit: Mutex::new(None),
        }
    }

    /// None is an actual closed writer, not a fabricated zero-byte snapshot.
    pub(crate) fn available_bytes(&self) -> io::Result<Option<usize>> {
        let _gate = self.submission.lock().unwrap_or_else(|p| p.into_inner());
        if self.retired.load(Ordering::SeqCst) {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "pipe-retired"));
        }
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                self.handle.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } == 0
        {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        Ok(Some(available as usize))
    }

    pub fn verify_client(&self, expected: &RetainedProcess, job: &EngineJob) -> io::Result<()> {
        let mut actual_pid = 0;
        if unsafe { GetNamedPipeClientProcessId(self.handle.as_raw_handle(), &mut actual_pid) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        expected.revalidate()?;
        if actual_pid != expected.identity().pid
            || !job.contains(expected.handle())?
            || expected.identity().user_sid
                != capture_identity(unsafe { GetCurrentProcess() })?.user_sid
        {
            self.retire();
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private-pipe-peer-mismatch",
            ));
        }
        Ok(())
    }

    pub fn retire(&self) {
        let _gate = self
            .submission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.retired.store(true, Ordering::SeqCst);
        unsafe {
            CancelIoEx(self.handle.as_raw_handle(), std::ptr::null());
        }
    }

    #[cfg(test)]
    pub fn before_next_submit_for_test(&self, hook: Box<dyn FnOnce() + Send>) {
        *self.before_submit.lock().unwrap() = Some(hook);
    }

    fn before_submit(&self) {
        #[cfg(test)]
        {
            let hook = self.before_submit.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
        }
    }

    pub fn read(
        &self,
        buffer: &mut [u8],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> io::Result<usize> {
        let _reader = self
            .reader
            .try_lock()
            .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "private-pipe-reader-busy"))?;
        self.check_live()?;
        let result = (|| {
            let mut operation = Operation::new(&self.handle, Some(&self.retired))?;
            operation.check_before_start(cancel, deadline)?;
            self.before_submit();
            let mut bytes = 0;
            let (read, error) = {
                let _gate = self
                    .submission
                    .lock()
                    .map_err(|_| io::Error::other("private-pipe-gate-poisoned"))?;
                self.check_live()?;
                operation.check_before_start(cancel, deadline)?;
                let read = unsafe {
                    ReadFile(
                        self.handle.as_raw_handle(),
                        buffer.as_mut_ptr(),
                        buffer.len().min(u32::MAX as usize) as u32,
                        &mut bytes,
                        operation.pointer(),
                    )
                };
                let error = if read == 0 {
                    unsafe { GetLastError() }
                } else {
                    0
                };
                if error == ERROR_IO_PENDING {
                    operation.pending = true;
                }
                (read, error)
            };
            if read != 0 {
                self.check_live()?;
                operation.check_before_start(cancel, deadline)?;
                return Ok(bytes as usize);
            }
            match error {
                ERROR_IO_PENDING => {
                    let bytes = operation.complete(cancel, deadline)?;
                    self.check_live()?;
                    operation.check_before_start(cancel, deadline)?;
                    Ok(bytes as usize)
                }
                ERROR_BROKEN_PIPE => Ok(0),
                _ => Err(io::Error::from_raw_os_error(error as i32)),
            }
        })();
        if result.is_err() {
            self.retire();
        }
        result
    }

    pub fn write_all(
        &self,
        bytes: &[u8],
        cancel: &AtomicBool,
        deadline: Instant,
    ) -> io::Result<()> {
        let _writer = self
            .writer
            .try_lock()
            .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "private-pipe-writer-busy"))?;
        self.check_live()?;
        let result = (|| {
            let mut offset = 0;
            while offset < bytes.len() {
                let mut operation = Operation::new(&self.handle, Some(&self.retired))?;
                operation.check_before_start(cancel, deadline)?;
                self.before_submit();
                let mut written = 0;
                let remaining = &bytes[offset..];
                let (write, error) = {
                    let _gate = self
                        .submission
                        .lock()
                        .map_err(|_| io::Error::other("private-pipe-gate-poisoned"))?;
                    self.check_live()?;
                    operation.check_before_start(cancel, deadline)?;
                    let write = unsafe {
                        WriteFile(
                            self.handle.as_raw_handle(),
                            remaining.as_ptr(),
                            remaining.len().min(u32::MAX as usize) as u32,
                            &mut written,
                            operation.pointer(),
                        )
                    };
                    let error = if write == 0 {
                        unsafe { GetLastError() }
                    } else {
                        0
                    };
                    if error == ERROR_IO_PENDING {
                        operation.pending = true;
                    }
                    (write, error)
                };
                if write == 0 {
                    if error != ERROR_IO_PENDING {
                        return Err(io::Error::from_raw_os_error(error as i32));
                    }
                    written = operation.complete(cancel, deadline)?;
                }
                self.check_live()?;
                operation.check_before_start(cancel, deadline)?;
                if written == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "private-pipe-write-zero",
                    ));
                }
                offset += written as usize;
            }
            Ok(())
        })();
        if result.is_err() {
            self.retire();
        }
        result
    }

    fn check_live(&self) -> io::Result<()> {
        if self.retired.load(Ordering::SeqCst) {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "private-pipe-retired",
            ))
        } else {
            Ok(())
        }
    }
}

struct Operation<'a> {
    handle: &'a OwnedHandle,
    retired: Option<&'a AtomicBool>,
    overlapped: Box<OVERLAPPED>,
    _event: OwnedHandle,
    pending: bool,
}

impl<'a> Operation<'a> {
    fn new(handle: &'a OwnedHandle, retired: Option<&'a AtomicBool>) -> io::Result<Self> {
        let event =
            checked_handle(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })?;
        let mut overlapped = Box::<OVERLAPPED>::default();
        overlapped.hEvent = event.as_raw_handle();
        Ok(Self {
            handle,
            retired,
            overlapped,
            _event: event,
            pending: false,
        })
    }
    fn pointer(&mut self) -> *mut OVERLAPPED {
        self.overlapped.as_mut()
    }

    fn check_before_start(&self, cancel: &AtomicBool, deadline: Instant) -> io::Result<()> {
        if cancel.load(Ordering::SeqCst)
            || self.retired.is_some_and(|flag| flag.load(Ordering::SeqCst))
        {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "private-pipe-cancelled",
            ));
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "private-pipe-deadline",
            ));
        }
        Ok(())
    }

    fn complete(&mut self, cancel: &AtomicBool, deadline: Instant) -> io::Result<u32> {
        loop {
            if let Err(error) = self.check_before_start(cancel, deadline) {
                self.cancel_and_drain();
                return Err(error);
            }
            match unsafe { WaitForSingleObject(self.overlapped.hEvent, 5) } {
                WAIT_TIMEOUT => continue,
                WAIT_OBJECT_0 => {
                    let mut bytes = 0;
                    let result = unsafe {
                        GetOverlappedResult(
                            self.handle.as_raw_handle(),
                            self.pointer(),
                            &mut bytes,
                            0,
                        )
                    };
                    self.pending = false;
                    if result == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    return Ok(bytes);
                }
                _ => {
                    let error = io::Error::last_os_error();
                    self.cancel_and_drain();
                    return Err(error);
                }
            }
        }
    }

    fn cancel_and_drain(&mut self) {
        if self.pending {
            unsafe {
                CancelIoEx(self.handle.as_raw_handle(), self.pointer());
                let mut bytes = 0;
                // The OVERLAPPED and buffer must remain alive until kernel completion,
                // including cancellation. Real local-pipe bounded-join tests guard this path.
                GetOverlappedResult(self.handle.as_raw_handle(), self.pointer(), &mut bytes, 1);
            }
            self.pending = false;
        }
    }
}

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.cancel_and_drain();
    }
}
