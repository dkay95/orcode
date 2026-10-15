#![cfg(windows)]

#[path = "../src/platform/windows/identity.rs"]
mod identity;
#[path = "../src/platform/windows/filesystem.rs"]
mod filesystem;

use filesystem::PinnedImage;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn fixture() -> PathBuf {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    let root = std::env::temp_dir().join(format!("orcode-image-{:032x}", u128::from_le_bytes(bytes)));
    std::fs::create_dir(&root).unwrap();
    root
}

fn digest(bytes: &[u8]) -> [u8; 32] { Sha256::digest(bytes).into() }

#[test]
fn windows_image_hash_and_identity_come_from_retained_file() {
    let root = fixture();
    let path = root.join("candidate.exe");
    std::fs::write(&path, b"fixed fixture bytes").unwrap();
    let pinned = PinnedImage::open(&path, digest(b"fixed fixture bytes")).unwrap();
    assert_eq!(pinned.sha256(), &digest(b"fixed fixture bytes"));
    assert_eq!(pinned.identity().file_id128_hex.len(), 32);
    assert_eq!(pinned.identity().volume_serial_hex.len(), 16);
    assert_ne!(pinned.identity().file_id128_hex, "0".repeat(32));
    assert!(PinnedImage::open(&path, [1u8; 32]).is_err());
    assert!(std::fs::write(&path, b"replacement").is_err());
    assert!(std::fs::rename(&path, root.join("moved.exe")).is_err());
    assert!(std::fs::rename(&root, root.with_extension("moved")).is_err());
    pinned.revalidate().unwrap();
    drop(pinned);
    std::fs::write(&path, b"after close").unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_image_rejects_hardlinks_and_unsupported_namespaces() {
    let root = fixture();
    let path = root.join("candidate.exe");
    std::fs::write(&path, b"fixed").unwrap();
    std::fs::hard_link(&path, root.join("alias.exe")).unwrap();
    assert!(PinnedImage::open(&path, digest(b"fixed")).is_err());
    for path in ["C:relative.exe", "\\\\server\\share\\app.exe", "\\\\?\\GLOBALROOT\\Device\\app.exe",
        "C:\\path\\app.exe:stream", "C:\\path\\CON.exe", "C:\\path\\name.\\app.exe", "C:\\path\\..\\app.exe"] {
        assert!(PinnedImage::open(std::path::Path::new(path), [1u8; 32]).is_err(), "{path}");
    }
    std::fs::remove_dir_all(root).unwrap();
}
