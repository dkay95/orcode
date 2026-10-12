use sha2::{Digest, Sha256};

fn main() {
    println!("cargo:rerun-if-env-changed=ORCODE_GUI_PACKAGED_TRUST_POLICY");
    let generated = match std::env::var_os("ORCODE_GUI_PACKAGED_TRUST_POLICY") {
        None => {
            "pub(crate) const PACKAGED_APP_TRUST_POLICY: Option<PackagedAppTrustPolicy> = None;\n"
                .to_string()
        }
        Some(path) => compile_policy(std::path::Path::new(&path)),
    };
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(out.join("packaged_app_trust_policy.rs"), generated)
        .expect("write packaged trust policy");
    tauri_build::build()
}

fn compile_policy(path: &std::path::Path) -> String {
    use std::os::unix::fs::MetadataExt;
    let original = std::fs::symlink_metadata(path).expect("packaged trust policy metadata");
    assert!(
        !original.file_type().is_symlink(),
        "packaged trust policy must not be a symlink"
    );
    let canonical = std::fs::canonicalize(path).expect("invalid packaged trust policy path");
    let manifest =
        std::fs::canonicalize(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
            .expect("invalid manifest path");
    let root = std::fs::canonicalize(
        manifest
            .parent()
            .expect("gui root")
            .join(".devhome/package-policy"),
    )
    .expect("invalid packaged trust policy root");
    let transient = canonical
        .parent()
        .expect("invalid packaged trust policy parent");
    assert_eq!(
        transient.parent(),
        Some(root.as_path()),
        "invalid packaged trust policy root"
    );
    assert_eq!(
        canonical.file_name().and_then(|name| name.to_str()),
        Some("policy.json"),
        "invalid packaged trust policy name"
    );
    for entry in [&root, transient, canonical.as_path()] {
        let meta =
            std::fs::symlink_metadata(entry).expect("packaged trust policy ancestry metadata");
        assert!(
            meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
            "packaged trust policy ancestry must be owner-only"
        );
    }
    let meta = std::fs::symlink_metadata(&canonical).expect("packaged trust policy metadata");
    assert!(
        meta.file_type().is_file(),
        "packaged trust policy must be a file"
    );
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&canonical).expect("read packaged trust policy"))
            .expect("invalid packaged trust policy JSON");
    let object = value
        .as_object()
        .expect("invalid packaged trust policy object");
    let expected = [
        "bundleIdentifier",
        "designatedRequirementSha256",
        "policySha256",
        "productVersion",
        "schemaVersion",
        "teamIdentifier",
    ];
    assert!(
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key)),
        "invalid packaged trust policy keys"
    );
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["bundleIdentifier"], "dev.orcode.gui");
    assert_eq!(value["productVersion"], "0.7.0");
    let team = value["teamIdentifier"]
        .as_str()
        .expect("invalid TeamIdentifier");
    assert!(
        team.len() == 10
            && team
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
        "invalid TeamIdentifier"
    );
    let requirement = digest(
        value["designatedRequirementSha256"]
            .as_str()
            .expect("invalid requirement digest"),
    );
    let policy = digest(
        value["policySha256"]
            .as_str()
            .expect("invalid policy digest"),
    );
    let safe = serde_json::json!({"schemaVersion":1,"bundleIdentifier":"dev.orcode.gui","productVersion":"0.7.0","teamIdentifier":team,"designatedRequirementSha256":hex(&requirement)});
    assert_eq!(
        Sha256::digest(serde_json::to_vec(&safe).unwrap()).as_slice(),
        policy,
        "invalid policy digest"
    );
    format!("pub(crate) const PACKAGED_APP_TRUST_POLICY: Option<PackagedAppTrustPolicy> = Some(PackagedAppTrustPolicy {{ schema_version: 1, bundle_identifier: \"dev.orcode.gui\", product_version: \"0.7.0\", team_identifier: {team:?}, designated_requirement_sha256: {requirement:?}, policy_sha256: {policy:?} }});\n")
}
fn digest(value: &str) -> [u8; 32] {
    assert!(value.len() == 64, "invalid SHA-256 digest");
    let mut out = [0; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).expect("invalid SHA-256 digest");
    }
    out
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
