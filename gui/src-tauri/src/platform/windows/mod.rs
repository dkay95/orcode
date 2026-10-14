//! Deliberately unavailable until native Job ownership and private IPC are proven.
//! In particular, a successful std::process::Command spawn is not a safe fallback.

pub(crate) mod identity;
pub(crate) mod job;
pub(crate) mod pipe;

use crate::engine::{ControlPipeWriter, NativeActionReader, NativeChannelError, ProcessSpawnGuard};

pub struct NativeSidecarChannels {
    unavailable: std::convert::Infallible,
}

pub fn create_native_sidecar_channels(
    _guard: &ProcessSpawnGuard,
) -> Result<NativeSidecarChannels, NativeChannelError> {
    Err(NativeChannelError::Io(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "windows-native-private-channel-unavailable",
    )))
}

impl NativeSidecarChannels {
    pub fn prepare_command(
        &mut self,
        _command: &mut std::process::Command,
    ) -> Result<(), NativeChannelError> {
        match self.unavailable {}
    }
    pub fn parent_after_spawn(&mut self) {
        match self.unavailable {}
    }
    pub fn into_parent_ends(
        self,
    ) -> Result<(NativeActionReader, ControlPipeWriter), NativeChannelError> {
        match self.unavailable {}
    }
    pub fn all_four_original_pipe_ends_were_cloexec_before_command(&self) -> bool {
        match self.unavailable {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{
        acquire_process_spawn_guard, desktop_kimi_private_channel_status, spawn_raw_engine_after,
        DesktopKimiPrivateChannelStatus,
    };
    use std::cell::Cell;

    #[test]
    fn unsupported_native_channels_never_report_candidate_ready() {
        let guard = acquire_process_spawn_guard();
        let error = match create_native_sidecar_channels(&guard) {
            Err(error) => error,
            Ok(_) => panic!("unproved channels must not exist"),
        };
        assert!(error
            .to_string()
            .contains("windows-native-private-channel-unavailable"));
        assert!(matches!(
            desktop_kimi_private_channel_status(),
            DesktopKimiPrivateChannelStatus::Unavailable { .. }
        ));
    }

    #[test]
    fn unsupported_engine_does_not_spawn_or_run_after_spawn_callback() {
        let guard = acquire_process_spawn_guard();
        let called = Cell::new(false);
        let result = spawn_raw_engine_after(
            &guard,
            std::process::Command::new("orcode-must-not-be-spawned"),
            || called.set(true),
        );
        assert!(
            matches!(result,Err(crate::engine::EngineError::Spawn(ref reason))
            if reason=="windows-native-engine-unavailable")
        );
        assert!(!called.get());
    }
}
