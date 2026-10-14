//! Operating-system mechanics; no model, WebView or owner policy lives here.

#[cfg(unix)]
pub(crate) mod unix;
#[cfg(windows)]
pub(crate) mod windows;

#[cfg(unix)]
pub const NODE_BINARY_NAME: &str = "node";
#[cfg(windows)]
pub const NODE_BINARY_NAME: &str = "node.exe";

pub(crate) fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(windows)]
    {
        let _ = status;
        None
    }
}

pub(crate) fn home_from_env(
    get: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    get(key).filter(|value| !value.is_empty()).map(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_home_does_not_fall_back_to_another_platforms_variable() {
        let selected = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let other = if cfg!(windows) { "HOME" } else { "USERPROFILE" };
        assert_eq!(
            home_from_env(|key| (key == other).then(|| "foreign".into())),
            None
        );
        assert_eq!(
            home_from_env(|key| (key == selected).then(|| "".into())),
            None
        );
        assert_eq!(
            home_from_env(|key| (key == selected).then(|| "chosen".into())),
            Some(std::path::PathBuf::from("chosen"))
        );
    }
}
