#![cfg(windows)]

#[path = "../src/platform/windows/filesystem.rs"]
mod filesystem;
#[path = "../src/platform/windows/identity.rs"]
mod identity;
#[path = "../src/platform/windows/job.rs"]
mod job;

use filesystem::PinnedImage;
use sha2::{Digest, Sha256};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;
use std::time::Duration;
use windows_sys::Win32::Storage::FileSystem::*;

fn fixture() -> PathBuf {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    let root =
        std::env::temp_dir().join(format!("orcode-image-{:032x}", u128::from_le_bytes(bytes)));
    std::fs::create_dir(&root).unwrap();
    root
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

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
    for path in [
        "C:relative.exe",
        "\\\\server\\share\\app.exe",
        "\\\\?\\GLOBALROOT\\Device\\app.exe",
        "C:\\path\\app.exe:stream",
        "C:\\path\\CON.exe",
        "C:\\path\\name.\\app.exe",
        "C:\\path\\..\\app.exe",
    ] {
        let error = match PinnedImage::open(std::path::Path::new(path), [1u8; 32]) {
            Ok(_) => panic!("accepted {path}"),
            Err(error) => error,
        };
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied,
            "{path}: {error}"
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn image_child_fixture() {
    if let Some(root) = std::env::var_os("ORCODE_IMAGE_CHILD_ROOT") {
        std::fs::write(PathBuf::from(root).join("started"), b"started").unwrap();
    }
}

#[test]
fn windows_real_image_pin_matches_suspended_process_not_identical_copy() {
    let root = fixture();
    let images = root.join("Projekt Grüße 2026");
    std::fs::create_dir(&images).unwrap();
    let path = images.join("native child.exe");
    let other = images.join("identical copy.exe");
    std::fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
    std::fs::copy(&path, &other).unwrap();
    let hash = digest(&std::fs::read(&path).unwrap());
    let pinned = PinnedImage::open(&path, hash).unwrap();
    let different = PinnedImage::open(&other, hash).unwrap();
    assert_ne!(pinned.identity(), different.identity());
    let job = job::EngineJob::new().unwrap();
    let mut child = job
        .create_suspended(
            &job::WindowsLaunchSpec {
                executable: pinned.launch_path().to_owned(),
                arguments: vec![
                    "--exact".into(),
                    "image_child_fixture".into(),
                    "--nocapture".into(),
                ],
                directory: root.clone(),
                environment: vec![(
                    "ORCODE_IMAGE_CHILD_ROOT".into(),
                    root.as_os_str().to_owned(),
                )],
            },
            &job::WindowsStdio::null().unwrap(),
        )
        .unwrap();
    let process = identity::RetainedProcess::open(child.identity().pid).unwrap();
    pinned.matches_process(&process).unwrap();
    assert!(different.matches_process(&process).is_err());
    assert!(!root.join("started").exists());
    assert!(std::fs::rename(&path, images.join("swap.exe")).is_err());
    pinned.matches_process(&process).unwrap();
    child.resume().unwrap();
    assert_eq!(child.wait(Duration::from_secs(10)).unwrap(), Some(0));
    assert!(root.join("started").exists());
    drop(child);
    drop(process);
    drop(pinned);
    drop(different);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_image_rejects_preexisting_writable_handle() {
    let root = fixture();
    let path = root.join("candidate.exe");
    std::fs::write(&path, b"fixed").unwrap();
    let writable = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    assert!(PinnedImage::open(&path, digest(b"fixed")).is_err());
    drop(writable);
    assert!(PinnedImage::open(&path, digest(b"fixed")).is_ok());
    std::fs::remove_dir_all(root).unwrap();
}

fn attribute_handle(path: &std::path::Path) -> std::os::windows::io::OwnedHandle {
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    identity::checked_handle(unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_WRITE_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    })
    .unwrap()
}

fn make_junction(
    handle: &std::os::windows::io::OwnedHandle,
    target: &std::path::Path,
) -> std::io::Result<()> {
    // REPARSE_DATA_BUFFER mount-point form (MS-FSCC 2.1.2.3); positive control below
    // prevents an invalid buffer or insufficient access from masquerading as protection.
    let print: Vec<u16> = target.as_os_str().encode_wide().collect();
    let substitute: Vec<u16> = format!("\\??\\{}", target.display())
        .encode_utf16()
        .collect();
    let mut paths = substitute.clone();
    paths.push(0);
    paths.extend_from_slice(&print);
    paths.push(0);
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0xa0000003u32.to_le_bytes()); // IO_REPARSE_TAG_MOUNT_POINT
    bytes.extend_from_slice(&((8 + paths.len() * 2) as u16).to_le_bytes());
    bytes.extend_from_slice(&0u16.to_le_bytes());
    for value in [
        0u16,
        (substitute.len() * 2) as u16,
        ((substitute.len() + 1) * 2) as u16,
        (print.len() * 2) as u16,
    ] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    for value in paths {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let mut returned = 0;
    if unsafe {
        windows_sys::Win32::System::IO::DeviceIoControl(
            handle.as_raw_handle(),
            0x000900a4,
            bytes.as_ptr().cast(),
            bytes.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[test]
fn windows_pinned_nonempty_ancestor_rejects_attributes_only_reparse_insertion() {
    let root = fixture();
    let ancestor = root.join("ancestor");
    let target = root.join("target");
    let control = root.join("empty-control");
    for path in [&ancestor, &target, &control] {
        std::fs::create_dir(path).unwrap();
    }
    std::fs::write(ancestor.join("candidate.exe"), b"fixed").unwrap();
    let pinned = PinnedImage::open(&ancestor.join("candidate.exe"), digest(b"fixed")).unwrap();
    let empty = attribute_handle(&control);
    make_junction(&empty, &target).expect("attributes-only empty-directory positive control");
    drop(empty);
    std::fs::remove_dir(&control).unwrap();
    let metadata = attribute_handle(&ancestor);
    let error =
        make_junction(&metadata, &target).expect_err("pinned ancestor cannot become a junction");
    assert_eq!(
        error.raw_os_error(),
        Some(145),
        "must specifically reject nonempty directory: {error}"
    );
    pinned.revalidate().unwrap();
    drop(metadata);
    drop(pinned);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_image_rejects_junction_at_each_acquisition_depth() {
    let root = fixture();
    let target = root.join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::create_dir(target.join("nested")).unwrap();
    std::fs::write(target.join("candidate.exe"), b"fixed").unwrap();
    std::fs::write(target.join("nested/candidate.exe"), b"fixed").unwrap();
    for suffix in ["candidate.exe", "nested/candidate.exe"] {
        let link = root.join("link");
        std::fs::create_dir(&link).unwrap();
        let handle = attribute_handle(&link);
        make_junction(&handle, &target).unwrap();
        drop(handle);
        assert!(PinnedImage::open(&link.join(suffix), digest(b"fixed")).is_err());
        std::fs::remove_dir(&link).unwrap();
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn windows_image_revalidation_refuses_case_sensitive_metadata_change() {
    let root = fixture();
    let ancestor = root.join("ancestor");
    std::fs::create_dir(&ancestor).unwrap();
    std::fs::write(ancestor.join("candidate.exe"), b"fixed").unwrap();
    let pinned = PinnedImage::open(&ancestor.join("candidate.exe"), digest(b"fixed")).unwrap();
    let handle = attribute_handle(&ancestor);
    let set_flag = |flags| {
        let info = FILE_CASE_SENSITIVE_INFO { Flags: flags };
        unsafe {
            SetFileInformationByHandle(
                handle.as_raw_handle(),
                FileCaseSensitiveInfo,
                (&info as *const FILE_CASE_SENSITIVE_INFO).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        }
    };
    if set_flag(1) != 0 {
        assert!(pinned.revalidate().is_err());
        assert_ne!(set_flag(0), 0, "restore fixture metadata");
        pinned.revalidate().unwrap();
    } else {
        // Some Windows editions disable this NTFS feature. This is an observed
        // OS refusal, not a skipped native check or claimed successful flip.
        let error = std::io::Error::last_os_error();
        assert!(
            matches!(error.raw_os_error(), Some(5 | 50)),
            "unexpected metadata failure: {error}"
        );
        pinned.revalidate().unwrap();
    }
    drop(handle);
    drop(pinned);
    std::fs::remove_dir_all(root).unwrap();
}
