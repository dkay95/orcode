//! Shared build/runtime schema; integrity is supplied by an independently compiled digest.
use serde::Deserialize;
use std::collections::HashSet;

pub const MAX_MANIFEST_BYTES: usize = 32 * 1024 * 1024;
const NODE_SHA256: &str = "ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeManifest {
    schema_version: u32,
    platform: String,
    arch: String,
    node_version: String,
    pub files: Vec<RuntimeFile>,
}

fn invalid() -> String {
    "invalid-windows-runtime-manifest".into()
}

pub fn safe_resource_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 2048 {
        return false;
    }
    for component in path.split('/') {
        let lower = component.to_lowercase();
        let base = lower.split('.').next().unwrap_or("");
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.ends_with(['.', ' '])
            || component
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || ["con", "prn", "aux", "nul"].contains(&base)
            || ((base.starts_with("com") || base.starts_with("lpt"))
                && base.chars().count() == 4
                && matches!(base.chars().last(), Some('1'..='9' | '¹' | '²' | '³')))
            || [
                ".orcode",
                ".codex",
                ".claude",
                ".devhome",
                "auth.json",
                "credentials",
                "credentials.json",
                ".env",
            ]
            .contains(&lower.as_str())
            || lower.starts_with(".env.")
        {
            return false;
        }
    }
    matches!(
        path,
        "node.exe" | "orcode-platform-host.exe" | "package.json" | "dist/gui-server.js"
    ) || path.starts_with("dist/")
        || path.starts_with("node_modules/")
}

pub fn digest_bytes(hex: &str) -> Result<[u8; 32], String> {
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(invalid());
    }
    let mut result = [0u8; 32];
    for (index, chunk) in hex.as_bytes().chunks_exact(2).enumerate() {
        let value = |byte: u8| {
            if byte <= b'9' {
                byte - b'0'
            } else {
                byte - b'a' + 10
            }
        };
        result[index] = value(chunk[0]) * 16 + value(chunk[1]);
    }
    Ok(result)
}

impl RuntimeManifest {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(invalid());
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if value.schema_version != 1
            || value.platform != "win32"
            || value.arch != "x64"
            || value.node_version != "24.22.0"
            || value.files.len() > 100_000
        {
            return Err(invalid());
        }
        let mut seen = HashSet::new();
        let mut total = 0u64;
        for file in &value.files {
            if !safe_resource_path(&file.path)
                || file.bytes > 512 * 1024 * 1024
                || !seen.insert(file.path.to_uppercase())
            {
                return Err(invalid());
            }
            digest_bytes(&file.sha256)?;
            total = total.checked_add(file.bytes).ok_or_else(invalid)?;
            if total > 2 * 1024 * 1024 * 1024 {
                return Err(invalid());
            }
        }
        for path in [
            "node.exe",
            "orcode-platform-host.exe",
            "package.json",
            "dist/gui-server.js",
        ] {
            if !value.files.iter().any(|file| file.path == path) {
                return Err(invalid());
            }
        }
        if !value
            .files
            .iter()
            .any(|file| file.path.starts_with("node_modules/"))
            || value
                .files
                .iter()
                .find(|file| file.path == "node.exe")
                .unwrap()
                .sha256
                != NODE_SHA256
        {
            return Err(invalid());
        }
        Ok(value)
    }
}
