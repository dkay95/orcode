#[path = "../src/runtime_manifest.rs"]
mod runtime_manifest;
#[path = "../build_support/windows_runtime.rs"]
mod windows_runtime;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn manifest() -> Value {
    json!({"schemaVersion":1,"platform":"win32","arch":"x64","nodeVersion":"24.22.0",
    "files":[
      {"path":"dist/gui-server.js","bytes":1,"sha256":"1".repeat(64)},
      {"path":"node.exe","bytes":1,"sha256":"ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c"},
      {"path":"node_modules/a/index.js","bytes":1,"sha256":"2".repeat(64)},
      {"path":"orcode-platform-host.exe","bytes":1,"sha256":"3".repeat(64)},
      {"path":"package.json","bytes":1,"sha256":"4".repeat(64)}
    ]})
}

#[test]
fn runtime_manifest_requires_closed_target_inventory_and_no_aliases() {
    let bytes = serde_json::to_vec(&manifest()).unwrap();
    let parsed = runtime_manifest::RuntimeManifest::parse(&bytes).unwrap();
    assert_eq!(parsed.files.len(), 5);
    for path in [
        "../escape",
        "node_modules/AUX.txt",
        "node_modules/.codex/auth.json",
        "dist/a:ads",
        "node_modules/a/.. /b",
    ] {
        let mut value = manifest();
        value["files"][2]["path"] = json!(path);
        assert!(
            runtime_manifest::RuntimeManifest::parse(&serde_json::to_vec(&value).unwrap()).is_err(),
            "{path}"
        );
    }
    for field in ["platform", "arch", "nodeVersion"] {
        let mut value = manifest();
        value[field] = json!("wrong");
        assert!(
            runtime_manifest::RuntimeManifest::parse(&serde_json::to_vec(&value).unwrap()).is_err()
        );
    }
    let mut value = manifest();
    value["files"][2]["rawHandle"] = json!(100);
    assert!(
        runtime_manifest::RuntimeManifest::parse(&serde_json::to_vec(&value).unwrap()).is_err()
    );
    let mut value = manifest();
    value["files"].as_array_mut().unwrap().remove(3);
    assert!(
        runtime_manifest::RuntimeManifest::parse(&serde_json::to_vec(&value).unwrap()).is_err()
    );
    let mut value = manifest();
    value["files"]
        .as_array_mut()
        .unwrap()
        .push(json!({"path":"DIST/GUI-SERVER.JS","bytes":1,"sha256":"5".repeat(64)}));
    assert!(
        runtime_manifest::RuntimeManifest::parse(&serde_json::to_vec(&value).unwrap()).is_err()
    );
    assert!(
        runtime_manifest::RuntimeManifest::parse(br#"{"schemaVersion":1,"schemaVersion":1}"#)
            .is_err()
    );
}

#[test]
fn build_binding_requires_manifest_and_hashes_exact_bytes() {
    assert!(
        windows_runtime::compile_binding(None, false, "windows", "x86_64")
            .unwrap()
            .contains("None")
    );
    assert!(windows_runtime::compile_binding(None, true, "windows", "x86_64").is_err());
    let root = std::env::temp_dir().join(format!(
        "orcode-manifest-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("runtime-manifest.json");
    let bytes = serde_json::to_vec_pretty(&manifest()).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let generated =
        windows_runtime::compile_binding(Some(&path), true, "windows", "x86_64").unwrap();
    assert!(generated.contains(&digest));
    assert!(windows_runtime::compile_binding(Some(&path), true, "macos", "aarch64").is_err());
    assert!(windows_runtime::compile_binding(Some(&path), true, "windows", "aarch64").is_err());
    std::fs::write(&path, [bytes.clone(), b"\n".to_vec()].concat()).unwrap();
    let changed = windows_runtime::compile_binding(Some(&path), true, "windows", "x86_64").unwrap();
    assert_ne!(generated, changed);
    std::fs::write(&path, b"{}").unwrap();
    assert!(windows_runtime::compile_binding(Some(&path), true, "windows", "x86_64").is_err());
    std::fs::remove_dir_all(root).unwrap();
}
