//! Creation-time Job ownership. The Job is lifetime ownership, NOT a filesystem sandbox.

use super::identity::{checked_handle, inheritable, ProcessIdentity, RetainedProcess};
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    DuplicateHandle, SetHandleInformation, DUPLICATE_SAME_ACCESS, HANDLE, HANDLE_FLAG_INHERIT,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::*;

/// Exact launch data; deliberately not reconstructed from Command (env_clear/raw_args are opaque).
pub struct WindowsLaunchSpec {
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub directory: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
}

pub struct WindowsStdio {
    handles: [OwnedHandle; 3],
}

impl WindowsStdio {
    pub fn null() -> io::Result<Self> {
        let source = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("NUL")?;
        let duplicate = || {
            let mut raw = std::ptr::null_mut();
            if unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    source.as_raw_handle(),
                    GetCurrentProcess(),
                    &mut raw,
                    0,
                    1,
                    DUPLICATE_SAME_ACCESS,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            checked_handle(raw)
        };
        Self::new(duplicate()?, duplicate()?, duplicate()?)
    }

    pub fn new(stdin: OwnedHandle, stdout: OwnedHandle, stderr: OwnedHandle) -> io::Result<Self> {
        let handles = [stdin, stdout, stderr];
        for handle in &handles {
            if unsafe {
                SetHandleInformation(
                    handle.as_raw_handle(),
                    HANDLE_FLAG_INHERIT,
                    HANDLE_FLAG_INHERIT,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(Self { handles })
    }

    fn raw(&self) -> [HANDLE; 3] {
        self.handles.each_ref().map(|handle| handle.as_raw_handle())
    }
}

#[derive(Clone)]
pub struct EngineJob {
    handle: Arc<OwnedHandle>,
}

impl EngineJob {
    pub fn new() -> io::Result<Self> {
        let handle =
            checked_handle(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            handle: Arc::new(handle),
        })
    }

    pub fn handle_is_inheritable(&self) -> io::Result<bool> {
        inheritable(self.handle.as_raw_handle())
    }

    pub fn contains(&self, process: HANDLE) -> io::Result<bool> {
        let mut result = 0;
        if unsafe { IsProcessInJob(process, self.handle.as_raw_handle(), &mut result) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(result != 0)
    }

    pub fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.handle.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn active_processes(&self) -> io::Result<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.handle.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(info.ActiveProcesses)
    }

    pub fn assign(&self, child: &NativeProcess) -> io::Result<()> {
        if !self.contains(child.handle())?
            && unsafe { AssignProcessToJobObject(self.handle.as_raw_handle(), child.handle()) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn create_suspended(
        &self,
        spec: &WindowsLaunchSpec,
        stdio: &WindowsStdio,
    ) -> io::Result<NativeProcess> {
        if !spec.executable.is_absolute()
            || !spec.directory.is_absolute()
            || spec
                .executable
                .extension()
                .and_then(OsStr::to_str)
                .is_none_or(|ext| !ext.eq_ignore_ascii_case("exe"))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "absolute-native-executable-required",
            ));
        }
        let application = wide(&spec.executable)?;
        let directory = wide(&spec.directory)?;
        let mut command_line = command_line(spec)?;
        let environment = environment(&spec.environment)?;
        let handles = stdio.raw();
        let jobs = [self.handle.as_raw_handle()];
        let attributes = AttributeList::new(&handles, &jobs)?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = attributes.pointer();
        let mut information = PROCESS_INFORMATION::default();
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                CREATE_SUSPENDED
                    | CREATE_UNICODE_ENVIRONMENT
                    | EXTENDED_STARTUPINFO_PRESENT
                    | CREATE_NO_WINDOW,
                environment.as_ptr().cast(),
                directory.as_ptr(),
                &startup.StartupInfo,
                &mut information,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // Acquire both returned handles immediately. Kill/reap on every error before resume.
        let process = checked_handle(information.hProcess)?;
        let thread = match checked_handle(information.hThread) {
            Ok(thread) => thread,
            Err(error) => {
                terminate_and_reap(process.as_raw_handle());
                return Err(error);
            }
        };
        let retained = match process.try_clone().and_then(RetainedProcess::from_owned) {
            Ok(process) => process,
            Err(error) => {
                terminate_and_reap(process.as_raw_handle());
                return Err(error);
            }
        };
        let child = NativeProcess {
            process: retained,
            thread: Some(thread),
            job: self.clone(),
        };
        self.assign(&child)?;
        if !self.contains(child.handle())? {
            return Err(io::Error::other("creation-job-missing"));
        }
        Ok(child)
    }
}

pub struct NativeProcess {
    process: RetainedProcess,
    thread: Option<OwnedHandle>,
    job: EngineJob,
}

impl NativeProcess {
    pub fn identity(&self) -> &ProcessIdentity {
        self.process.identity()
    }
    pub fn handle(&self) -> HANDLE {
        self.process.handle()
    }

    pub fn resume(&mut self) -> io::Result<()> {
        let thread = self
            .thread
            .take()
            .ok_or_else(|| io::Error::other("process-already-resumed"))?;
        self.process.revalidate()?;
        if !self.job.contains(self.handle())? {
            return Err(io::Error::other("process-not-job-owned"));
        }
        if unsafe { ResumeThread(thread.as_raw_handle()) } != 1 {
            self.terminate_and_wait()?;
            return Err(io::Error::other("unexpected-suspend-count"));
        }
        Ok(())
    }

    pub fn try_wait(&self) -> io::Result<Option<u32>> {
        self.wait(Duration::ZERO)
    }

    pub fn wait(&self, duration: Duration) -> io::Result<Option<u32>> {
        let millis = duration.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        match unsafe { WaitForSingleObject(self.handle(), millis) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(self.handle(), &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(code))
            }
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub fn terminate_and_wait(&self) -> io::Result<()> {
        self.job.terminate()?;
        if self.wait(Duration::from_secs(5))?.is_none() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process-reap-timeout",
            ));
        }
        Ok(())
    }
}

impl Drop for NativeProcess {
    fn drop(&mut self) {
        // Core exit must also terminate any helper/descendant that could retain stdio.
        let _ = self.terminate_and_wait();
    }
}

fn terminate_and_reap(handle: HANDLE) {
    unsafe {
        TerminateProcess(handle, 1);
        WaitForSingleObject(handle, 5000);
    }
}

fn wide(value: impl AsRef<OsStr>) -> io::Result<Vec<u16>> {
    let mut result: Vec<u16> = value.as_ref().encode_wide().collect();
    if result.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded-nul"));
    }
    result.push(0);
    Ok(result)
}

fn command_line(spec: &WindowsLaunchSpec) -> io::Result<Vec<u16>> {
    // CRT argument quoting: every argument is quoted; backslashes before quotes/end are doubled.
    let mut result = Vec::new();
    for argument in std::iter::once(spec.executable.as_os_str())
        .chain(spec.arguments.iter().map(OsString::as_os_str))
    {
        if !result.is_empty() {
            result.push(b' ' as u16);
        }
        result.push(b'"' as u16);
        let mut slashes = 0;
        for code in argument.encode_wide() {
            if code == 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded-nul"));
            }
            if code == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            let count = if code == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            };
            result.extend(std::iter::repeat_n(b'\\' as u16, count));
            result.push(code);
            slashes = 0;
        }
        result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        result.push(b'"' as u16);
    }
    if result.len() >= 32767 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "command-line-too-long",
        ));
    }
    result.push(0);
    Ok(result)
}

fn environment(entries: &[(OsString, OsString)]) -> io::Result<Vec<u16>> {
    let mut entries: Vec<_> = entries
        .iter()
        .map(|(key, value)| {
            let key = key
                .to_str()
                .ok_or_else(|| io::Error::other("invalid-environment-key"))?;
            if key.is_empty() || key.contains(['=', '\0']) {
                return Err(io::Error::other("invalid-environment-key"));
            }
            let mut line = wide(OsString::from(format!("{key}=")))?;
            line.pop();
            line.extend(wide(value)?);
            Ok((key.to_uppercase(), line))
        })
        .collect::<io::Result<Vec<_>>>()?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    if entries.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(io::Error::other("duplicate-environment-key"));
    }
    let mut result: Vec<u16> = entries.into_iter().flat_map(|(_, line)| line).collect();
    if result.is_empty() {
        result.push(0);
    }
    result.push(0);
    Ok(result)
}

struct AttributeList {
    storage: Vec<usize>,
    initialized: bool,
}

impl AttributeList {
    fn pointer(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_ptr().cast_mut().cast()
    }

    fn new(handles: &[HANDLE], jobs: &[HANDLE]) -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut list = Self {
            storage: vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())],
            initialized: false,
        };
        if unsafe {
            InitializeProcThreadAttributeList(list.storage.as_mut_ptr().cast(), 2, 0, &mut bytes)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        list.initialized = true;
        for (attribute, values) in [
            (PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles),
            (PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs),
        ] {
            if unsafe {
                UpdateProcThreadAttribute(
                    list.pointer(),
                    0,
                    attribute as usize,
                    values.as_ptr().cast(),
                    std::mem::size_of_val(values),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(list)
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.pointer());
            }
        }
    }
}
