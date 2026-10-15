#[cfg(target_os = "macos")]
#[path = "build_support/packaged_policy_macos.rs"]
mod packaged_policy_macos;
#[path = "src/runtime_manifest.rs"]
mod runtime_manifest;
#[path = "build_support/windows_runtime.rs"]
mod windows_runtime;

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
    println!("cargo:rerun-if-env-changed=ORCODE_WINDOWS_RUNTIME_MANIFEST");
    println!("cargo:rerun-if-env-changed=ORCODE_WINDOWS_PACKAGE_REQUIRED");
    let runtime_path =
        std::env::var_os("ORCODE_WINDOWS_RUNTIME_MANIFEST").map(std::path::PathBuf::from);
    let required = match std::env::var("ORCODE_WINDOWS_PACKAGE_REQUIRED") {
        Err(std::env::VarError::NotPresent) => false,
        Ok(value) if value == "1" => true,
        _ => panic!("invalid Windows package-required build flag"),
    };
    if let Some(path) = &runtime_path {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let binding = windows_runtime::compile_binding(
        runtime_path.as_deref(),
        required,
        &std::env::var("CARGO_CFG_TARGET_OS").expect("target OS"),
        &std::env::var("CARGO_CFG_TARGET_ARCH").expect("target architecture"),
    )
    .expect("compile Windows runtime binding");
    std::fs::write(out.join("windows_runtime_binding.rs"), binding)
        .expect("write Windows runtime binding");
    tauri_build::build()
}
