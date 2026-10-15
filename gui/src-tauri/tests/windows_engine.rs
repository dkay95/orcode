#![cfg(windows)]
use orcode_gui_lib::engine::{
    acquire_process_spawn_guard, spawn_native_raw_engine, NativeWindowsLaunchSpec, RawEngineEvent,
};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn fixture() -> PathBuf {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).unwrap();
    let root = std::env::temp_dir().join(format!(
        "orcode-engine-{:032x}",
        u128::from_le_bytes(random)
    ));
    std::fs::create_dir(&root).unwrap();
    root
}
fn spec(root: &Path, mode: &str) -> NativeWindowsLaunchSpec {
    NativeWindowsLaunchSpec {
        executable: std::env::current_exe().unwrap(),
        directory: root.to_owned(),
        arguments: vec![
            "--exact".into(),
            "windows_engine_fixture".into(),
            "--nocapture".into(),
        ],
        environment: vec![
            ("ORCODE_ENGINE_FIXTURE".into(), mode.into()),
            ("ORCODE_ENGINE_ROOT".into(), root.as_os_str().to_owned()),
        ],
    }
}

#[test]
fn windows_engine_fixture() {
    let Ok(mode) = std::env::var("ORCODE_ENGINE_FIXTURE") else {
        return;
    };
    match mode.as_str() {
        "final-burst" => {
            use std::io::Write;
            let mut stdout = std::io::stdout().lock();
            for _ in 0..64 {
                stdout.write_all(&[b'x'; 4096]).unwrap();
            }
            stdout.write_all(b"FINAL-MARKER").unwrap();
            stdout.flush().unwrap();
        }
        "stdin-eof" => {
            use std::io::Read;
            let mut input = Vec::new();
            std::io::stdin().read_to_end(&mut input).unwrap();
            println!("EOF-MARKER");
        }
        "grandchild" => {
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "windows_engine_fixture", "--nocapture"])
                .env("ORCODE_ENGINE_FIXTURE", "sleep")
                .spawn()
                .unwrap();
            std::fs::write(
                PathBuf::from(std::env::var_os("ORCODE_ENGINE_ROOT").unwrap()).join("grandchild"),
                child.id().to_string(),
            )
            .unwrap();
        }
        "sleep" => loop {
            std::thread::sleep(Duration::from_millis(50));
        },
        _ => panic!("unknown fixture"),
    }
}

fn drain(raw: &mut orcode_gui_lib::engine::RawEngine) -> Vec<u8> {
    let end = Instant::now() + Duration::from_secs(15);
    let mut bytes = Vec::new();
    loop {
        assert!(Instant::now() < end, "native drain must complete");
        match raw.recv_event_timeout(Duration::from_millis(100)) {
            Ok(RawEngineEvent::Stdout(chunk)) => {
                bytes.extend(chunk);
                std::thread::sleep(Duration::from_millis(2));
            }
            Ok(RawEngineEvent::Stderr(_)) => (),
            Ok(RawEngineEvent::Terminated { code, signal }) => {
                assert_eq!(code, Some(0));
                assert_eq!(signal, None);
                break;
            }
            Ok(RawEngineEvent::Error) => panic!("native stream failure"),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
            Err(error) => panic!("native stream closed before termination: {error}"),
        }
    }
    bytes
}

#[test]
fn windows_engine_retains_final_burst_under_backpressure() {
    let root = fixture();
    let guard = acquire_process_spawn_guard();
    let mut raw =
        spawn_native_raw_engine(&guard, &spec(&root, "final-burst"), |_, _| Ok(())).unwrap();
    let bytes = drain(&mut raw);
    assert!(bytes.windows(12).any(|s| s == b"FINAL-MARKER"));
    assert!(bytes.iter().filter(|&&b| b == b'x').count() >= 64 * 4096);
    raw.revoke_and_join(Duration::from_secs(2)).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_engine_stdin_close_reaches_real_child() {
    let root = fixture();
    let guard = acquire_process_spawn_guard();
    let mut raw =
        spawn_native_raw_engine(&guard, &spec(&root, "stdin-eof"), |_, _| Ok(())).unwrap();
    raw.write_line("owner-input").unwrap();
    assert!(raw.close_stdin());
    assert!(String::from_utf8_lossy(&drain(&mut raw)).contains("EOF-MARKER"));
    raw.revoke_and_join(Duration::from_secs(2)).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_engine_natural_exit_reaps_descendants_before_terminal_event() {
    let root = fixture();
    let guard = acquire_process_spawn_guard();
    let mut raw =
        spawn_native_raw_engine(&guard, &spec(&root, "grandchild"), |_, _| Ok(())).unwrap();
    drain(&mut raw);
    let pid: u32 = std::fs::read_to_string(root.join("grandchild"))
        .unwrap()
        .parse()
        .unwrap();
    use windows_sys::Win32::System::Threading::*;
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if !handle.is_null() {
        assert_eq!(
            unsafe { WaitForSingleObject(handle, 0) },
            windows_sys::Win32::Foundation::WAIT_OBJECT_0
        );
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
    }
    raw.revoke_and_join(Duration::from_secs(2)).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
