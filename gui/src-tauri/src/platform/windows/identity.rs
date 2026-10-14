//! Process identity is retained through a real handle, never reconstructed from a PID later.

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use windows_sys::Win32::Foundation::{
    GetHandleInformation, LocalFree, FILETIME, HANDLE, HANDLE_FLAG_INHERIT,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::System::Threading::{
    GetProcessId, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};

pub(crate) fn checked_handle(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: the caller transfers one successful Win32 owned-handle return value.
        Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
    }
}

pub(crate) fn inheritable(handle: HANDLE) -> io::Result<bool> {
    let mut flags = 0;
    if unsafe { GetHandleInformation(handle, &mut flags) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(flags & HANDLE_FLAG_INHERIT != 0)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub creation_time: String,
    pub user_sid: String,
    pub image: PathBuf,
}

pub struct RetainedProcess {
    handle: OwnedHandle,
    identity: ProcessIdentity,
}

impl RetainedProcess {
    pub fn open(pid: u32) -> io::Result<Self> {
        let raw = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        Self::from_owned(checked_handle(raw)?)
    }

    pub fn from_owned(handle: OwnedHandle) -> io::Result<Self> {
        if inheritable(handle.as_raw_handle())? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process-handle-inheritable",
            ));
        }
        let identity = capture_identity(handle.as_raw_handle())?;
        Ok(Self { handle, identity })
    }

    pub fn handle(&self) -> HANDLE {
        self.handle.as_raw_handle()
    }
    pub fn identity(&self) -> &ProcessIdentity {
        &self.identity
    }

    pub fn revalidate(&self) -> io::Result<()> {
        if capture_identity(self.handle())? != self.identity {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process-identity-changed",
            ));
        }
        Ok(())
    }
}

fn token_sid(process: HANDLE) -> io::Result<String> {
    let mut raw = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = checked_handle(raw)?;
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut bytes,
        );
    }
    if bytes == 0 || bytes > 64 * 1024 {
        return Err(io::Error::other("invalid-token-size"));
    }
    // usize storage keeps TOKEN_USER and its embedded SID suitably aligned.
    let mut buffer = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut sid = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = (|| {
        let mut length = 0;
        while length < 256 && unsafe { *sid.add(length) } != 0 {
            length += 1;
        }
        if length == 256 {
            return Err(io::Error::other("invalid-token-sid"));
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(sid, length) })
            .map_err(|_| io::Error::other("invalid-token-sid"))
    })();
    unsafe {
        LocalFree(sid.cast());
    }
    result
}

pub fn capture_identity(handle: HANDLE) -> io::Result<ProcessIdentity> {
    let pid = unsafe { GetProcessId(handle) };
    if pid == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let creation = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    if creation == 0 {
        return Err(io::Error::other("invalid-process-creation-time"));
    }
    let mut image = vec![0u16; 32768];
    let mut length = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(handle, 0, image.as_mut_ptr(), &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    use std::os::windows::ffi::OsStringExt;
    Ok(ProcessIdentity {
        pid,
        creation_time: creation.to_string(),
        user_sid: token_sid(handle)?,
        image: PathBuf::from(std::ffi::OsString::from_wide(&image[..length as usize])),
    })
}
