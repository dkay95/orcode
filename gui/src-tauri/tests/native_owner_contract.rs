#[path = "../src/native_owner.rs"]
mod native_owner;
use native_owner::{OwnerStartContext, WindowsOwnerChallengeGate};

fn gate() -> WindowsOwnerChallengeGate {
    WindowsOwnerChallengeGate::new(
        OwnerStartContext {
            child_pid: 1000,
            generation: 7,
            pipe_instance_id: "p".repeat(32),
        },
        100,
    )
    .unwrap()
}

fn hello() -> serde_json::Value {
    serde_json::json!({"kind":"windows-owner-hello", "version":1, "requestId":"r".repeat(32),
        "sessionId":"s".repeat(32), "challenge":"c".repeat(43), "childPid":1000,
        "childGeneration":7, "pipeInstanceId":"p".repeat(32), "deadlineAt":200})
}

#[test]
fn windows_bootstrap_rejects_replay_generation_and_expiry() {
    let bytes = serde_json::to_vec(&hello()).unwrap();
    let mut good = gate();
    assert_eq!(good.accept(&bytes, 100).unwrap().child_pid(), 1000);
    assert!(good.accept(&bytes, 100).is_err());
    for (field, value) in [
        ("childGeneration", serde_json::json!(6)),
        ("childPid", serde_json::json!(1001)),
        ("pipeInstanceId", serde_json::json!("x".repeat(32))),
        ("deadlineAt", serde_json::json!(100)),
    ] {
        let mut invalid = hello();
        invalid[field] = value;
        assert!(gate()
            .accept(&serde_json::to_vec(&invalid).unwrap(), 100)
            .is_err());
    }
    let mut expired = gate();
    assert!(expired.accept(&bytes, 200).is_err());
    assert!(expired.accept(&bytes, 100).is_err());
    let mut revoked = gate();
    revoked.revoke();
    assert!(revoked.accept(&bytes, 100).is_err());
    let mut rollback = gate();
    assert!(rollback.accept(&bytes, 99).is_err());
    assert!(rollback.accept(&bytes, 100).is_err());
}

#[test]
fn windows_hello_parser_is_exact_bounded_and_never_mac_startup() {
    for (field, value) in [
        ("rawHandle", serde_json::json!(123)),
        ("version", serde_json::json!(2)),
        ("kind", serde_json::json!("packaged-startup")),
        ("challenge", serde_json::json!("bad")),
        ("deadlineAt", serde_json::json!(30101)),
        ("childGeneration", serde_json::json!(9007199254740992u64)),
    ] {
        let mut invalid = hello();
        invalid[field] = value;
        assert!(gate()
            .accept(&serde_json::to_vec(&invalid).unwrap(), 100)
            .is_err());
    }
    let duplicate = serde_json::to_string(&hello())
        .unwrap()
        .replace("\"version\":1", "\"version\":1,\"version\":1");
    assert!(gate().accept(duplicate.as_bytes(), 100).is_err());
    assert!(gate().accept(&vec![b' '; 4097], 100).is_err());
}
