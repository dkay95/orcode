#![cfg(windows)]

#[path = "../src/platform/windows/identity.rs"]
mod identity;
#[path = "../src/platform/windows/job.rs"]
mod job;
#[path = "../src/platform/windows/pipe.rs"]
mod pipe;

use job::{EngineJob, WindowsLaunchSpec, WindowsStdio};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

struct TestController(std::process::Child);
impl Drop for TestController {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn temporary_directory() -> PathBuf {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    let path = std::env::temp_dir().join(format!(
        "orcode-win-test-{:032x}",
        u128::from_le_bytes(bytes)
    ));
    std::fs::create_dir(&path).unwrap();
    path
}

fn launch_spec(mode: &str, root: &std::path::Path) -> WindowsLaunchSpec {
    WindowsLaunchSpec {
        executable: std::env::current_exe().unwrap(),
        arguments: vec![
            "--exact".into(),
            "native_child_fixture".into(),
            "--nocapture".into(),
        ],
        directory: root.to_path_buf(),
        environment: vec![
            ("ORCODE_WINDOWS_TEST_MODE".into(), mode.into()),
            (
                "ORCODE_WINDOWS_TEST_ROOT".into(),
                root.as_os_str().to_owned(),
            ),
        ],
    }
}

#[test]
fn native_child_fixture() {
    let Ok(mode) = std::env::var("ORCODE_WINDOWS_TEST_MODE") else {
        return;
    };
    let root = PathBuf::from(std::env::var_os("ORCODE_WINDOWS_TEST_ROOT").unwrap());
    match mode.as_str() {
        "marker" => {
            std::fs::write(root.join("started"), b"started").unwrap();
        }
        "inheritance" => {
            let raw: usize = std::env::var("ORCODE_TEST_SENTINEL")
                .unwrap()
                .parse()
                .unwrap();
            unsafe {
                SetEvent(raw as HANDLE);
            }
            std::fs::write(root.join("checked"), b"checked").unwrap();
        }
        "spawn-grandchild" => {
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "native_child_fixture", "--nocapture"])
                .env("ORCODE_WINDOWS_TEST_MODE", "sleep")
                .spawn()
                .unwrap();
            std::fs::write(root.join("grandchild-pid"), child.id().to_string()).unwrap();
            std::fs::write(root.join("tree-ready"), b"ready").unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        "controller" => {
            let job = EngineJob::new().unwrap();
            let stdio = WindowsStdio::null().unwrap();
            let mut child = job
                .create_suspended(&launch_spec("spawn-grandchild", &root), &stdio)
                .unwrap();
            std::fs::write(root.join("child-pid"), child.identity().pid.to_string()).unwrap();
            child.resume().unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        "sleep" => loop {
            std::thread::sleep(Duration::from_millis(50));
        },
        "foreign-peer" => {
            let owner = identity::RetainedProcess::open(
                std::env::var("ORCODE_TEST_OWNER_PID")
                    .unwrap()
                    .parse()
                    .unwrap(),
            )
            .unwrap();
            let _client =
                pipe::connect_owner(&std::env::var("ORCODE_TEST_PIPE_NAME").unwrap(), &owner)
                    .unwrap();
            loop {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        _ => panic!("unknown fixture mode"),
    }
}

fn wait_file(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "missing fixture marker: {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn windows_spawn_is_job_owned_before_resume() {
    let root = temporary_directory();
    let job = EngineJob::new().unwrap();
    assert!(!job.handle_is_inheritable().unwrap());
    let stdio = WindowsStdio::null().unwrap();
    let mut child = job
        .create_suspended(&launch_spec("marker", &root), &stdio)
        .unwrap();
    assert!(job.contains(child.handle()).unwrap());
    assert!(!root.join("started").exists());
    assert!(child.try_wait().unwrap().is_none());
    assert!(child.identity().creation_time.parse::<u64>().unwrap() > 0);
    child.resume().unwrap();
    assert_eq!(child.wait(Duration::from_secs(10)).unwrap(), Some(0));
    assert!(root.join("started").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_tools_inherit_no_setup_or_job_handles() {
    let root = temporary_directory();
    let attributes = windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let raw = unsafe { CreateEventW(&attributes, 1, 0, std::ptr::null()) };
    assert!(!raw.is_null());
    let sentinel = unsafe { OwnedHandle::from_raw_handle(raw) };
    let job = EngineJob::new().unwrap();
    let stdio = WindowsStdio::null().unwrap();
    let mut spec = launch_spec("inheritance", &root);
    spec.environment.push((
        "ORCODE_TEST_SENTINEL".into(),
        (sentinel.as_raw_handle() as usize).to_string().into(),
    ));
    let mut child = job.create_suspended(&spec, &stdio).unwrap();
    child.resume().unwrap();
    assert_eq!(child.wait(Duration::from_secs(10)).unwrap(), Some(0));
    assert!(root.join("checked").exists());
    assert_eq!(
        unsafe { WaitForSingleObject(sentinel.as_raw_handle(), 0) },
        WAIT_TIMEOUT
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_job_kills_grandchildren_on_shell_abort() {
    let root = temporary_directory();
    // Deliberately NOT in the engine Job: this process simulates the native shell.
    let controller = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "native_child_fixture", "--nocapture"])
        .env("ORCODE_WINDOWS_TEST_MODE", "controller")
        .env("ORCODE_WINDOWS_TEST_ROOT", &root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut controller = TestController(controller);
    wait_file(&root.join("tree-ready"));
    let child_pid: u32 = std::fs::read_to_string(root.join("child-pid"))
        .unwrap()
        .parse()
        .unwrap();
    let grandchild_pid: u32 = std::fs::read_to_string(root.join("grandchild-pid"))
        .unwrap()
        .parse()
        .unwrap();
    let child = identity::RetainedProcess::open(child_pid).unwrap();
    let grandchild = identity::RetainedProcess::open(grandchild_pid).unwrap();
    controller.0.kill().unwrap();
    controller.0.wait().unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(child.handle(), 5000) },
        WAIT_OBJECT_0
    );
    assert_eq!(
        unsafe { WaitForSingleObject(grandchild.handle(), 5000) },
        WAIT_OBJECT_0
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_suspended_process_is_reaped_if_abandoned() {
    let root = temporary_directory();
    let job = EngineJob::new().unwrap();
    let stdio = WindowsStdio::null().unwrap();
    let child = job
        .create_suspended(&launch_spec("marker", &root), &stdio)
        .unwrap();
    let retained = identity::RetainedProcess::open(child.identity().pid).unwrap();
    drop(child);
    assert_eq!(
        unsafe { WaitForSingleObject(retained.handle(), 5000) },
        WAIT_OBJECT_0
    );
    assert!(!root.join("started").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_pipe_rejects_foreign_peer() {
    let root = temporary_directory();
    let server = pipe::PrivatePipeServer::new().unwrap();
    let job = EngineJob::new().unwrap();
    let stdio = WindowsStdio::null().unwrap();
    let mut intended = job
        .create_suspended(&launch_spec("sleep", &root), &stdio)
        .unwrap();
    intended.resume().unwrap();
    let expected = identity::RetainedProcess::open(intended.identity().pid).unwrap();
    let mut spec = launch_spec("foreign-peer", &root);
    spec.environment
        .push(("ORCODE_TEST_PIPE_NAME".into(), server.name().into()));
    spec.environment.push((
        "ORCODE_TEST_OWNER_PID".into(),
        std::process::id().to_string().into(),
    ));
    let mut foreign = job.create_suspended(&spec, &stdio).unwrap();
    foreign.resume().unwrap();
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let connection = server
        .accept(&cancel, Instant::now() + Duration::from_secs(5))
        .unwrap();
    assert!(connection.verify_client(&expected, &job).is_err());
    foreign.terminate_and_wait().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_cancelled_pipe_io_joins_boundedly() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let server = pipe::PrivatePipeServer::new().unwrap();
    let name = server.name().to_owned();
    let owner = identity::RetainedProcess::open(std::process::id()).unwrap();
    let (keep, kept) = std::sync::mpsc::channel::<()>();
    let client = std::thread::spawn(move || {
        let _pipe = pipe::connect_owner(&name, &owner).unwrap();
        kept.recv().unwrap();
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let connection = server
        .accept(&cancel, Instant::now() + Duration::from_secs(5))
        .unwrap();
    let thread_cancel = Arc::clone(&cancel);
    let reader = std::thread::spawn(move || {
        let mut byte = [0u8];
        connection.read(
            &mut byte,
            &thread_cancel,
            Instant::now() + Duration::from_secs(10),
        )
    });
    std::thread::sleep(Duration::from_millis(30));
    let start = Instant::now();
    cancel.store(true, Ordering::SeqCst);
    assert_eq!(
        reader.join().unwrap().unwrap_err().kind(),
        std::io::ErrorKind::Interrupted
    );
    assert!(start.elapsed() < Duration::from_millis(500));
    keep.send(()).unwrap();
    client.join().unwrap();
}

#[test]
fn windows_stalled_private_write_obeys_deadline() {
    let server = pipe::PrivatePipeServer::new().unwrap();
    let name = server.name().to_owned();
    let owner = identity::RetainedProcess::open(std::process::id()).unwrap();
    let (keep, kept) = std::sync::mpsc::channel::<()>();
    let client = std::thread::spawn(move || {
        let _pipe = pipe::connect_owner(&name, &owner).unwrap();
        kept.recv().unwrap();
    });
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let connection = server
        .accept(&cancel, Instant::now() + Duration::from_secs(5))
        .unwrap();
    let start = Instant::now();
    let error = connection
        .write_all(
            &vec![0u8; 1024 * 1024],
            &cancel,
            start + Duration::from_millis(100),
        )
        .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(start.elapsed() < Duration::from_millis(500));
    keep.send(()).unwrap();
    client.join().unwrap();
}

#[test]
fn windows_retire_fences_a_write_before_submission() {
    use std::sync::{atomic::AtomicBool, Arc};
    let server = pipe::PrivatePipeServer::new().unwrap();
    let name = server.name().to_owned();
    let owner = identity::RetainedProcess::open(std::process::id()).unwrap();
    let client = std::thread::spawn(move || pipe::connect_owner(&name, &owner).unwrap());
    let cancel = AtomicBool::new(false);
    let connection = Arc::new(
        server
            .accept(&cancel, Instant::now() + Duration::from_secs(5))
            .unwrap(),
    );
    let client = client.join().unwrap();
    let (reached, wait_reached) = std::sync::mpsc::channel();
    let (release, wait_release) = std::sync::mpsc::channel();
    connection.before_next_submit_for_test(Box::new(move || {
        reached.send(()).unwrap();
        wait_release.recv_timeout(Duration::from_secs(5)).unwrap();
    }));
    let writer_connection = Arc::clone(&connection);
    let writer = std::thread::spawn(move || {
        writer_connection.write_all(
            b"must-not-be-sent",
            &AtomicBool::new(false),
            Instant::now() + Duration::from_secs(5),
        )
    });
    wait_reached.recv_timeout(Duration::from_secs(5)).unwrap();
    connection.retire();
    release.send(()).unwrap();
    assert!(writer.join().unwrap().is_err());
    let mut buffer = [0u8; 32];
    assert_eq!(
        client
            .read(
                &mut buffer,
                &cancel,
                Instant::now() + Duration::from_millis(50)
            )
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::TimedOut
    );
}
