#![cfg(windows)]
#[path = "../src/platform/windows/filesystem.rs"]
mod filesystem;
#[path = "../src/platform/windows/identity.rs"]
mod identity;
#[path = "../src/platform/windows/job.rs"]
mod job;
#[path = "../src/platform/windows/native_bridge.rs"]
mod native_bridge;
#[path = "../src/native_owner.rs"]
mod native_owner;
#[path = "../src/platform/windows/pipe.rs"]
mod pipe;
#[path = "../src/private_frames.rs"]
mod private_frames;

use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

fn fixture() -> PathBuf {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    let root =
        std::env::temp_dir().join(format!("orcode-bridge-{:032x}", u128::from_le_bytes(bytes)));
    std::fs::create_dir(&root).unwrap();
    root
}

fn exercise(mode: &str) {
    let root = fixture();
    let node = PathBuf::from(
        std::env::var_os("ORCODE_TEST_NODE").expect("real Windows Node fixture is mandatory"),
    );
    let helper = PathBuf::from(env!("CARGO_BIN_EXE_orcode-platform-host"));
    let node_hash: [u8; 32] = Sha256::digest(std::fs::read(&node).unwrap()).into();
    assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(&node).unwrap())),
        "ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c"
    );
    let helper_hash: [u8; 32] = Sha256::digest(std::fs::read(&helper).unwrap()).into();
    let pinned_node = Arc::new(filesystem::PinnedImage::open(&node, node_hash).unwrap());
    // This is a real, independently built test helper, not a publisher/setup proof.
    let pinned_helper = Arc::new(filesystem::PinnedImage::open(&helper, helper_hash).unwrap());
    let server = native_bridge::NativeOwnerServer::new(7).unwrap();
    let context = serde_json::json!({"ownerPid":server.owner().pid,"ownerTime":server.owner().creation_time,
        "generation":7,"pipe":server.name(),"instance":server.instance(),"helper":helper,"mode":mode,"root":root});
    let job = job::EngineJob::new().unwrap();
    let mut core = job
        .create_suspended(
            &job::WindowsLaunchSpec {
                executable: pinned_node.launch_path().to_owned(),
                arguments: vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/windows-native-bridge.mjs")
                    .into_os_string()],
                directory: root.clone(),
                environment: vec![
                    ("ORCODE_BRIDGE_CONTEXT".into(), context.to_string().into()),
                    (
                        "SystemRoot".into(),
                        std::env::var_os("SystemRoot").expect("Windows SystemRoot"),
                    ),
                ],
            },
            &job::WindowsStdio::null().unwrap(),
        )
        .unwrap();
    let retained_core = identity::RetainedProcess::open(core.identity().pid).unwrap();
    pinned_node.matches_process(&retained_core).unwrap();
    core.resume().unwrap();
    let result = server.establish(
        retained_core,
        job.clone(),
        pinned_node,
        pinned_helper,
        Arc::new(AtomicBool::new(false)),
    );
    if mode == "valid" {
        let binding = result.expect("real Core -> helper -> native owner bootstrap");
        assert_eq!(binding.generation(), 7);
        assert_ne!(binding.peer_pid(), binding.engine_pid());
        let action = binding.read_action().unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&action).unwrap()["fixture"],
            "private-action"
        );
        binding.write_control(br#"{"fixture":"accepted"}"#).unwrap();
        assert_eq!(core.wait(Duration::from_secs(10)).unwrap(), Some(0));
        assert_eq!(
            std::fs::read(root.join("accepted")).unwrap(),
            b"private-control"
        );
        binding.revoke();
    } else {
        assert!(
            result.is_err(),
            "invalid {mode} cannot establish native binding"
        );
        core.terminate_and_wait().unwrap();
        assert!(!root.join("accepted").exists());
    }
    drop(core);
    drop(job);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_real_node_helper_owner_bootstrap_is_private_and_generation_bound() {
    exercise("valid");
}
#[test]
fn windows_real_owner_bridge_rejects_wrong_generation() {
    exercise("wrong-generation");
}
#[test]
fn windows_real_owner_bridge_rejects_expired_hello() {
    exercise("expired");
}
