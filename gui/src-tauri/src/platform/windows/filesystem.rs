//! Read-only executable pin. Native filesystem mutations/journals are separate operations.
//! A pin is build-bound file integrity, never publisher or owner-consent authority.

use super::identity::{checked_handle, inheritable, RetainedProcess};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{HANDLE, UNICODE_STRING};
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_NATIVE};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

const MAX_IMAGE_BYTES: u64 = 512 * 1024 * 1024;

fn refused(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason)
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub volume_serial_hex: String,
    pub file_id128_hex: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Observation {
    identity: FileIdentity,
    attributes: u32,
    size: u64,
    native_path: Vec<u16>,
    directory: bool,
}

struct DirectoryPin {
    handle: OwnedHandle,
    observation: Observation,
    name: Option<String>,
}

pub struct PinnedImage {
    directories: Vec<DirectoryPin>,
    file: Mutex<File>,
    observation: Observation,
    leaf_name: String,
    launch_path: PathBuf,
    digest: [u8; 32],
}

impl PinnedImage {
    pub fn open(path: &Path, expected_digest: [u8; 32]) -> io::Result<Self> {
        let (drive, components) = validated_path(path)?;
        if expected_digest == [0u8; 32] {
            return Err(refused("image-digest-missing"));
        }
        let root_name: Vec<u16> = format!("{drive}:\\")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // Only fixed local NTFS. An externally supplied UNC/device namespace never reaches this call.
        if unsafe { GetDriveTypeW(root_name.as_ptr()) } != 3 {
            return Err(refused("image-volume-not-local-fixed"));
        }
        let root = checked_handle(unsafe {
            CreateFileW(
                root_name.as_ptr(),
                FILE_GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        })?;
        let root_observation = observe(root.as_raw_handle(), true)?;
        let mut directories = vec![DirectoryPin {
            handle: root,
            observation: root_observation,
            name: None,
        }];
        for name in &components[..components.len() - 1] {
            let handle = open_component(
                directories.last().unwrap().handle.as_raw_handle(),
                name,
                true,
            )?;
            let observation = observe(handle.as_raw_handle(), true)?;
            if observation.identity.volume_serial_hex
                != directories[0].observation.identity.volume_serial_hex
            {
                return Err(refused("image-cross-volume"));
            }
            directories.push(DirectoryPin {
                handle,
                observation,
                name: Some(name.clone()),
            });
        }
        let leaf_name = components.last().unwrap().clone();
        let handle = open_component(
            directories.last().unwrap().handle.as_raw_handle(),
            &leaf_name,
            false,
        )?;
        let observation = observe(handle.as_raw_handle(), false)?;
        if observation.identity.volume_serial_hex
            != directories[0].observation.identity.volume_serial_hex
        {
            return Err(refused("image-cross-volume"));
        }
        let launch_path = PathBuf::from(std::ffi::OsString::from_wide(&final_path(
            handle.as_raw_handle(),
            VOLUME_NAME_GUID,
        )?));
        let mut file = File::from(handle);
        let digest = hash_file(&mut file, observation.size)?;
        if digest != expected_digest {
            return Err(refused("image-digest-mismatch"));
        }
        let pinned = Self {
            directories,
            file: Mutex::new(file),
            observation,
            leaf_name,
            launch_path,
            digest,
        };
        pinned.revalidate()?;
        Ok(pinned)
    }

    pub fn sha256(&self) -> &[u8; 32] {
        &self.digest
    }
    pub fn identity(&self) -> &FileIdentity {
        &self.observation.identity
    }
    pub fn launch_path(&self) -> &Path {
        &self.launch_path
    }

    pub fn revalidate(&self) -> io::Result<()> {
        for (index, directory) in self.directories.iter().enumerate() {
            if observe(directory.handle.as_raw_handle(), true)? != directory.observation {
                return Err(refused("image-ancestor-changed"));
            }
            if let Some(name) = &directory.name {
                let reopened = open_component(
                    self.directories[index - 1].handle.as_raw_handle(),
                    name,
                    true,
                )?;
                if observe(reopened.as_raw_handle(), true)? != directory.observation {
                    return Err(refused("image-ancestor-binding-changed"));
                }
            }
        }
        let mut file = self
            .file
            .lock()
            .map_err(|_| refused("image-pin-poisoned"))?;
        if observe(file.as_raw_handle(), false)? != self.observation {
            return Err(refused("image-object-changed"));
        }
        let reopened = open_component(
            self.directories.last().unwrap().handle.as_raw_handle(),
            &self.leaf_name,
            false,
        )?;
        if observe(reopened.as_raw_handle(), false)? != self.observation
            || hash_file(&mut file, self.observation.size)? != self.digest
        {
            return Err(refused("image-binding-changed"));
        }
        Ok(())
    }

    /// Query returns a native NAME, not a backing-file handle. The continuously retained
    /// non-delete-shared namespace and no-reparse component opens are part of this proof.
    pub fn matches_process(&self, process: &RetainedProcess) -> io::Result<()> {
        process.revalidate()?;
        let mut buffer = vec![0u16; 32768];
        let mut length = buffer.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(
                process.handle(),
                PROCESS_NAME_NATIVE,
                buffer.as_mut_ptr(),
                &mut length,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if buffer[..length as usize] != self.observation.native_path {
            return Err(refused("process-image-name-mismatch"));
        }
        self.revalidate()
    }
}

fn validated_path(path: &Path) -> io::Result<(char, Vec<String>)> {
    let input = path
        .to_str()
        .ok_or_else(|| refused("image-path-not-unicode"))?;
    let input = input.strip_prefix("\\\\?\\").unwrap_or(input);
    let bytes = input.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
    {
        return Err(refused("image-path-not-absolute-local-drive"));
    }
    let components: Vec<String> = input[3..].split(['\\', '/']).map(str::to_owned).collect();
    if components.is_empty() || components.iter().any(|name| !valid_component(name)) {
        return Err(refused("image-path-component-invalid"));
    }
    Ok(((bytes[0] as char).to_ascii_uppercase(), components))
}

fn valid_component(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.encode_utf16().count() > 255
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|code| code < ' ' || "\\/:<>\"|?*".contains(code))
    {
        return false;
    }
    let base = name.split('.').next().unwrap().to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&base.as_str()) {
        return false;
    }
    !((base.starts_with("COM") || base.starts_with("LPT"))
        && base.len() == 4
        && matches!(base.as_bytes()[3], b'1'..=b'9'))
}

fn open_component(parent: HANDLE, name: &str, directory: bool) -> io::Result<OwnedHandle> {
    if !valid_component(name) {
        return Err(refused("native-component-invalid"));
    }
    let mut name: Vec<u16> = name.encode_utf16().collect();
    let unicode = UNICODE_STRING {
        Length: (name.len() * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent,
        ObjectName: &unicode,
        Attributes: 0x40, // OBJ_CASE_INSENSITIVE; case-sensitive directories are refused below.
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut result = std::ptr::null_mut();
    let mut status = IO_STATUS_BLOCK::default();
    let code = unsafe {
        NtCreateFile(
            &mut result,
            FILE_GENERIC_READ,
            &attributes,
            &mut status,
            std::ptr::null(),
            0,
            FILE_SHARE_READ | if directory { FILE_SHARE_WRITE } else { 0 },
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory {
                    FILE_DIRECTORY_FILE
                } else {
                    FILE_NON_DIRECTORY_FILE
                },
            std::ptr::null(),
            0,
        )
    };
    if code < 0 {
        return Err(io::Error::other(format!("native-open-failed-{code:#x}")));
    }
    checked_handle(result)
}

fn query<T: Default>(handle: HANDLE, class: FILE_INFO_BY_HANDLE_CLASS) -> io::Result<T> {
    let mut info = T::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            (&mut info as *mut T).cast(),
            std::mem::size_of::<T>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

fn observe(handle: HANDLE, directory: bool) -> io::Result<Observation> {
    if inheritable(handle)? {
        return Err(refused("image-handle-inheritable"));
    }
    let standard: FILE_STANDARD_INFO = query(handle, FileStandardInfo)?;
    let attribute: FILE_ATTRIBUTE_TAG_INFO = query(handle, FileAttributeTagInfo)?;
    let id: FILE_ID_INFO = query(handle, FileIdInfo)?;
    if standard.Directory != directory
        || standard.DeletePending
        || standard.EndOfFile < 0
        || (!directory
            && (standard.NumberOfLinks != 1
                || standard.EndOfFile == 0
                || standard.EndOfFile as u64 > MAX_IMAGE_BYTES))
        || attribute.FileAttributes
            & (FILE_ATTRIBUTE_REPARSE_POINT
                | FILE_ATTRIBUTE_OFFLINE
                | FILE_ATTRIBUTE_RECALL_ON_OPEN
                | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
            != 0
        || attribute.ReparseTag != 0
    {
        return Err(refused("image-object-unsupported"));
    }
    if directory {
        let case: FILE_CASE_SENSITIVE_INFO = query(handle, FileCaseSensitiveInfo)?;
        if case.Flags != 0 {
            return Err(refused("case-sensitive-image-directory"));
        }
    }
    let mut name = [0u16; 32];
    let mut flags = 0;
    if unsafe {
        GetVolumeInformationByHandleW(
            handle,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut flags,
            name.as_mut_ptr(),
            name.len() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let length = name
        .iter()
        .position(|&code| code == 0)
        .ok_or_else(|| refused("filesystem-name-invalid"))?;
    if String::from_utf16_lossy(&name[..length]) != "NTFS" {
        return Err(refused("image-filesystem-not-ntfs"));
    }
    let file_id128_hex: String = id
        .FileId
        .Identifier
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if id.VolumeSerialNumber == 0 || file_id128_hex == "0".repeat(32) {
        return Err(refused("image-file-id-unavailable"));
    }
    Ok(Observation {
        identity: FileIdentity {
            volume_serial_hex: format!("{:016x}", id.VolumeSerialNumber),
            file_id128_hex,
        },
        attributes: attribute.FileAttributes,
        size: if directory {
            0
        } else {
            standard.EndOfFile as u64
        },
        native_path: final_path(handle, VOLUME_NAME_NT)?,
        directory,
    })
}

fn final_path(handle: HANDLE, volume: GETFINALPATHNAMEBYHANDLE_FLAGS) -> io::Result<Vec<u16>> {
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            volume | FILE_NAME_NORMALIZED,
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize >= buffer.len() {
        return Err(refused("image-final-path-too-long"));
    }
    buffer.truncate(length as usize);
    Ok(buffer)
}

fn hash_file(file: &mut File, expected_size: u64) -> io::Result<[u8; 32]> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut total = 0;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > expected_size {
            return Err(refused("image-size-changed"));
        }
        hash.update(&buffer[..count]);
    }
    if total != expected_size {
        return Err(refused("image-size-changed"));
    }
    Ok(hash.finalize().into())
}
