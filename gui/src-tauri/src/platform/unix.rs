//! Unix mechanics only. Shared framing, policy and lifecycle remain in engine.
use crate::engine::{
    CollisionProbe, ControlPipeError, ControlPipeWriter, NativeActionReader, NativeChannelError,
    ProcessSpawnGuard, NATIVE_ACTION_CHILD_FD, NATIVE_CONTROL_CHILD_FD,
};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::time::{Duration, Instant};

fn set_cloexec(fd: RawFd) -> Result<(), NativeChannelError> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

fn has_cloexec(fd: RawFd) -> Result<bool, NativeChannelError> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(flags & libc::FD_CLOEXEC != 0)
}

pub(crate) fn set_nonblocking(fd: RawFd) -> Result<(), NativeChannelError> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub(crate) fn pipe_available_bytes(fd: RawFd) -> std::io::Result<usize> {
    let mut available: libc::c_int = 0;
    let result = unsafe { libc::ioctl(fd, libc::FIONREAD, &mut available) };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if available < 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "negative pipe byte count",
        ));
    }
    Ok(available as usize)
}

fn pipe_cloexec() -> Result<(OwnedFd, OwnedFd), NativeChannelError> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let write = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    set_cloexec(read.as_raw_fd())?;
    set_cloexec(write.as_raw_fd())?;
    Ok((read, write))
}

fn duplicate_above_fixed(fd: RawFd) -> Result<OwnedFd, NativeChannelError> {
    let duplicated = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, NATIVE_CONTROL_CHILD_FD + 1) };
    if duplicated < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
}

fn relocate_owned_above_fixed(source: OwnedFd) -> Result<OwnedFd, NativeChannelError> {
    let moved = duplicate_above_fixed(source.as_raw_fd())?;
    drop(source);
    Ok(moved)
}

pub(crate) fn write_nonblocking(
    file: &mut std::fs::File,
    bytes: &[u8],
    grace: Duration,
) -> Result<(), ControlPipeError> {
    let deadline = Instant::now() + grace;
    let mut offset = 0usize;
    while offset < bytes.len() {
        let result = unsafe {
            libc::write(
                file.as_raw_fd(),
                bytes[offset..].as_ptr().cast::<libc::c_void>(),
                bytes.len() - offset,
            )
        };
        if result > 0 {
            offset += result as usize;
            continue;
        }
        if result == 0 {
            return Err(ControlPipeError::Gone);
        }
        let error = std::io::Error::last_os_error();
        match error.kind() {
            std::io::ErrorKind::Interrupted => continue,
            std::io::ErrorKind::WouldBlock if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(2));
            }
            std::io::ErrorKind::WouldBlock => return Err(ControlPipeError::Stalled),
            std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::NotConnected => {
                return Err(ControlPipeError::Gone)
            }
            _ => return Err(ControlPipeError::Failed),
        }
    }
    Ok(())
}

pub struct NativeSidecarChannels {
    pub child_action_write_fd: RawFd,
    pub child_control_read_fd: RawFd,
    pub action_reader: NativeActionReader,
    pub control_writer: ControlPipeWriter,
    child_action_write: Option<OwnedFd>,
    child_control_read: Option<OwnedFd>,
    originals_cloexec: bool,
}

pub fn create_native_sidecar_channels(
    _guard: &ProcessSpawnGuard,
) -> Result<NativeSidecarChannels, NativeChannelError> {
    let (action_read, action_write) = pipe_cloexec()?;
    let (control_read, control_write) = pipe_cloexec()?;
    let originals = [
        action_read.as_raw_fd(),
        action_write.as_raw_fd(),
        control_read.as_raw_fd(),
        control_write.as_raw_fd(),
    ];
    let originals_cloexec = originals
        .iter()
        .try_fold(true, |all, fd| has_cloexec(*fd).map(|flag| all && flag))?;
    let action_reader = NativeActionReader::from_file(action_read.into());
    let control_writer = ControlPipeWriter::spawn(control_write.into())?;
    Ok(NativeSidecarChannels {
        child_action_write_fd: action_write.as_raw_fd(),
        child_control_read_fd: control_read.as_raw_fd(),
        action_reader,
        control_writer,
        child_action_write: Some(action_write),
        child_control_read: Some(control_read),
        originals_cloexec,
    })
}

impl NativeSidecarChannels {
    pub fn all_four_original_pipe_ends_were_cloexec_before_command(&self) -> bool {
        self.originals_cloexec
    }

    pub fn prepare_command(&mut self, command: &mut Command) -> Result<(), NativeChannelError> {
        let action = self.child_action_write.take().ok_or_else(|| {
            NativeChannelError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "action child end closed",
            ))
        })?;
        let control = self.child_control_read.take().ok_or_else(|| {
            NativeChannelError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "control child end closed",
            ))
        })?;
        // Always move both sources above both fixed targets. This is stronger
        // than branching on the usual pipe allocation and makes own-target,
        // other-target and swapped-source cases share one safe path.
        let moved_action = relocate_owned_above_fixed(action)?;
        let moved_control = relocate_owned_above_fixed(control)?;
        self.child_action_write = Some(moved_action);
        self.child_control_read = Some(moved_control);
        self.child_action_write_fd = self.child_action_write.as_ref().unwrap().as_raw_fd();
        self.child_control_read_fd = self.child_control_read.as_ref().unwrap().as_raw_fd();
        let action_source = self.child_action_write_fd;
        let control_source = self.child_control_read_fd;
        unsafe {
            command.pre_exec(move || {
                // Only async-signal-safe operations occur after fork.
                if libc::dup2(action_source, NATIVE_ACTION_CHILD_FD) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::dup2(control_source, NATIVE_CONTROL_CHILD_FD) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if action_source != NATIVE_ACTION_CHILD_FD {
                    libc::close(action_source);
                }
                if control_source != NATIVE_CONTROL_CHILD_FD {
                    libc::close(control_source);
                }
                Ok(())
            });
        }
        Ok(())
    }

    /// Closes exactly the two child ends in Rust. Retained action/control ends
    /// remain private to the shell.
    pub fn parent_after_spawn(&mut self) {
        self.child_action_write.take();
        self.child_control_read.take();
    }

    pub fn into_parent_ends(
        self,
    ) -> Result<(NativeActionReader, ControlPipeWriter), NativeChannelError> {
        if self.child_action_write.is_some() || self.child_control_read.is_some() {
            return Err(NativeChannelError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "child private ends are still retained by the parent",
            )));
        }
        Ok((self.action_reader, self.control_writer))
    }
}

pub fn probe_fixed_fd_collision_matrix(
    _guard: &ProcessSpawnGuard,
) -> Result<Vec<CollisionProbe>, NativeChannelError> {
    fn identity(fd: RawFd) -> Result<(libc::dev_t, libc::ino_t), NativeChannelError> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let stat = unsafe { stat.assume_init() };
        Ok((stat.st_dev, stat.st_ino))
    }
    fn move_to(source: OwnedFd, target: RawFd) -> Result<OwnedFd, NativeChannelError> {
        if unsafe { libc::dup2(source.as_raw_fd(), target) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        set_cloexec(target)?;
        drop(source);
        Ok(unsafe { OwnedFd::from_raw_fd(target) })
    }

    let rows = [
        (
            "source-equals-own-target",
            Some(NATIVE_ACTION_CHILD_FD),
            None,
        ),
        (
            "source-equals-other-target",
            Some(NATIVE_CONTROL_CHILD_FD),
            None,
        ),
        (
            "swapped-sources",
            Some(NATIVE_CONTROL_CHILD_FD),
            Some(NATIVE_ACTION_CHILD_FD),
        ),
        ("ordinary-sources", None, None),
    ];
    let mut probes = Vec::new();
    for (case, action_target, control_target) in rows {
        // Distinct kernel pipe identities prove direction, not merely that a
        // descriptor number happened to be open after the mapping.
        let (action_read, action_write) = pipe_cloexec()?;
        let (control_read, control_write) = pipe_cloexec()?;
        let action_identity = identity(action_write.as_raw_fd())?;
        let control_identity = identity(control_read.as_raw_fd())?;
        // Establish authoritative sources above the fixed pair first, then
        // release every original owner before creating a collision-shaped
        // descriptor at 198/199. A target number therefore has exactly one
        // OwnedFd owner even when the allocator handed an original pipe end
        // that exact number.
        let action_high = duplicate_above_fixed(action_write.as_raw_fd())?;
        let control_high = duplicate_above_fixed(control_read.as_raw_fd())?;
        drop((action_read, action_write, control_read, control_write));
        let action_source = match action_target {
            Some(target) => move_to(action_high, target)?,
            None => action_high,
        };
        let control_source = match control_target {
            Some(target) => move_to(control_high, target)?,
            None => control_high,
        };
        let sources_were_cloexec =
            has_cloexec(action_source.as_raw_fd())? && has_cloexec(control_source.as_raw_fd())?;
        // This is the same pre-Command relocation used by production.
        let moved_action = relocate_owned_above_fixed(action_source)?;
        let moved_control = relocate_owned_above_fixed(control_source)?;
        let mapped = unsafe {
            libc::dup2(moved_action.as_raw_fd(), NATIVE_ACTION_CHILD_FD) >= 0
                && libc::dup2(moved_control.as_raw_fd(), NATIVE_CONTROL_CHILD_FD) >= 0
        };
        let safe = mapped
            && sources_were_cloexec
            && identity(NATIVE_ACTION_CHILD_FD)? == action_identity
            && identity(NATIVE_CONTROL_CHILD_FD)? == control_identity
            && !has_cloexec(NATIVE_ACTION_CHILD_FD)?
            && !has_cloexec(NATIVE_CONTROL_CHILD_FD)?;
        unsafe {
            libc::close(NATIVE_ACTION_CHILD_FD);
            libc::close(NATIVE_CONTROL_CHILD_FD);
        }
        probes.push(CollisionProbe { case, safe });
    }
    Ok(probes)
}
