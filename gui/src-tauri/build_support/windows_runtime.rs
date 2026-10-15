use crate::runtime_manifest::{RuntimeManifest, MAX_MANIFEST_BYTES};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

pub fn compile_binding(
    path: Option<&Path>,
    required: bool,
    target_os: &str,
    target_arch: &str,
) -> Result<String, String> {
    let Some(path) = path else {
        return if required {
            Err("packaged Windows runtime manifest required".into())
        } else {
            Ok("pub(crate) const WINDOWS_RUNTIME_MANIFEST_SHA256: Option<&str> = None;\n".into())
        };
    };
    if target_os != "windows" || target_arch != "x86_64" {
        return Err("Windows runtime requires windows/x86_64 target".into());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "runtime manifest unavailable")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_MANIFEST_BYTES as u64
    {
        return Err("runtime manifest not a bounded regular file".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "runtime manifest open failed")?;
    let mut bytes = Vec::new();
    file.take((MAX_MANIFEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "runtime manifest read failed")?;
    RuntimeManifest::parse(&bytes)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    Ok(format!(
        "pub(crate) const WINDOWS_RUNTIME_MANIFEST_SHA256: Option<&str> = Some(\"{digest}\");\n"
    ))
}
