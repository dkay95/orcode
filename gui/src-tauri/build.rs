#[cfg(target_os = "macos")]
#[path = "build_support/packaged_policy_macos.rs"]
mod packaged_policy_macos;

fn main() {
    println!("cargo:rerun-if-env-changed=ORCODE_GUI_PACKAGED_TRUST_POLICY");
    let generated = match std::env::var_os("ORCODE_GUI_PACKAGED_TRUST_POLICY") {
        None => {
            "pub(crate) const PACKAGED_APP_TRUST_POLICY: Option<PackagedAppTrustPolicy> = None;\n"
                .to_string()
        }
        Some(path) => {
            assert_eq!(
                std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
                Ok("macos"),
                "macOS packaged trust policy is not valid for this target"
            );
            #[cfg(target_os = "macos")]
            {
                packaged_policy_macos::compile_policy(std::path::Path::new(&path))
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = path;
                panic!("macOS packaged policy requires a native macOS build host")
            }
        }
    };
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(out.join("packaged_app_trust_policy.rs"), generated)
        .expect("write packaged trust policy");
    tauri_build::build()
}
