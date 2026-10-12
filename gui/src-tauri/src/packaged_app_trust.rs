use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackagedAppTrustPolicy {
    pub(crate) schema_version: u8,
    pub(crate) bundle_identifier: &'static str,
    pub(crate) product_version: &'static str,
    pub(crate) team_identifier: &'static str,
    pub(crate) designated_requirement_sha256: [u8; 32],
    pub(crate) policy_sha256: [u8; 32],
}
#[derive(Debug, Clone, PartialEq, Eq)]
/// A verified identity can be obtained only from this module's trust verifier.
///
/// ```compile_fail
/// use orcode_gui_lib::packaged_app_trust::VerifiedPackagedApp;
/// let _forged = VerifiedPackagedApp {
///     executable_path: std::path::PathBuf::from("/Volumes/Fake/Fake.app/Contents/MacOS/fake"),
///     executable_device: 1,
///     executable_inode: 1,
///     executable_size: 1,
///     team_identifier: "ABCDE12345".into(),
///     executable_sha256: [1; 32],
///     policy_sha256: [2; 32],
/// };
/// ```
pub struct VerifiedPackagedApp {
    executable_path: PathBuf,
    executable_device: u64,
    executable_inode: u64,
    executable_size: u64,
    team_identifier: String,
    executable_sha256: [u8; 32],
    policy_sha256: [u8; 32],
}

impl VerifiedPackagedApp {
    pub(crate) fn executable_path(&self) -> &std::path::Path {
        &self.executable_path
    }

    pub(crate) fn executable_device(&self) -> u64 {
        self.executable_device
    }

    pub(crate) fn executable_inode(&self) -> u64 {
        self.executable_inode
    }

    pub(crate) fn executable_size(&self) -> u64 {
        self.executable_size
    }

    pub(crate) fn executable_sha256(&self) -> &[u8; 32] {
        &self.executable_sha256
    }

    pub(crate) fn policy_sha256(&self) -> &[u8; 32] {
        &self.policy_sha256
    }
}

#[cfg(test)]
pub(crate) fn verified_packaged_app_fixture(
    executable_path: &str,
    executable_device: u64,
    executable_inode: u64,
    executable_size: u64,
    team_identifier: &str,
    executable_sha256: [u8; 32],
    policy_sha256: [u8; 32],
) -> Result<VerifiedPackagedApp, PackagedTrustError> {
    let path = std::path::Path::new(executable_path);
    let team_is_canonical = team_identifier.len() == 10
        && team_identifier
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit());
    let packaged_path = path
        .ancestors()
        .find(|ancestor| ancestor.extension().is_some_and(|value| value == "app"))
        .is_some_and(|app| path.starts_with(app.join("Contents/MacOS")));
    if !path.is_absolute()
        || !path.starts_with("/Volumes")
        || !packaged_path
        || executable_device == 0
        || executable_inode == 0
        || executable_size == 0
        || !team_is_canonical
        || executable_sha256.iter().all(|byte| *byte == 0)
        || policy_sha256.iter().all(|byte| *byte == 0)
    {
        return unavailable();
    }
    Ok(VerifiedPackagedApp {
        executable_path: path.to_owned(),
        executable_device,
        executable_inode,
        executable_size,
        team_identifier: team_identifier.to_owned(),
        executable_sha256,
        policy_sha256,
    })
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackagedTrustError {
    NativeLocalActionUnavailable,
}

include!(concat!(env!("OUT_DIR"), "/packaged_app_trust_policy.rs"));
pub struct SecurityFrameworkCodeTrust;
impl SecurityFrameworkCodeTrust {
    pub fn verify_current(
        policy: &PackagedAppTrustPolicy,
    ) -> Result<VerifiedPackagedApp, PackagedTrustError> {
        if policy.schema_version != 1
            || policy.bundle_identifier != "dev.orcode.gui"
            || policy.product_version != "0.7.0"
        {
            return unavailable();
        }
        platform::verify(policy)
    }
}
pub fn verify_without_policy() -> Result<VerifiedPackagedApp, PackagedTrustError> {
    let policy = PACKAGED_APP_TRUST_POLICY
        .as_ref()
        .ok_or(PackagedTrustError::NativeLocalActionUnavailable)?;
    SecurityFrameworkCodeTrust::verify_current(policy)
}
fn unavailable<T>() -> Result<T, PackagedTrustError> {
    Err(PackagedTrustError::NativeLocalActionUnavailable)
}

trait MountBackingProbe {
    fn inspect_backing(
        &self,
        exact_device: &str,
    ) -> Result<MountBackingObservation, PackagedTrustError>;
}

#[derive(Clone, Copy)]
struct MountBackingObservation {
    exact_device_matches: bool,
    apple_disk_image_provider: bool,
    backing_url_property: bool,
    legacy_hdix_provider: bool,
}

impl MountBackingObservation {
    fn is_apple_disk_image(self) -> bool {
        self.exact_device_matches
            && ((self.apple_disk_image_provider && self.backing_url_property)
                || self.legacy_hdix_provider)
    }
}

#[derive(Clone, Copy)]
struct MountObservation<'a> {
    read_only: bool,
    local: bool,
    under_volumes: bool,
    canonical_mount_root: bool,
    executable_under_mount: bool,
    exact_device: &'a str,
    file_system: &'a str,
}

fn validate_mount_observation(
    observation: MountObservation<'_>,
    probe: &dyn MountBackingProbe,
) -> Result<(), PackagedTrustError> {
    let canonical_device = observation
        .exact_device
        .strip_prefix("/dev/")
        .is_some_and(|name| {
            name.starts_with("disk")
                && name.len() > "disk".len()
                && name.bytes().all(|byte| byte.is_ascii_alphanumeric())
        });
    if !observation.read_only
        || !observation.local
        || !observation.under_volumes
        || !observation.canonical_mount_root
        || !observation.executable_under_mount
        || !canonical_device
        || !matches!(observation.file_system, "apfs" | "hfs")
    {
        return unavailable();
    }
    if !probe
        .inspect_backing(observation.exact_device)?
        .is_apple_disk_image()
    {
        return unavailable();
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub enum TrustFixture {
    Unsigned,
    AdHoc,
    MissingTeamIdentifier,
    WrongDesignatedRequirement,
    AlteredSealedResource,
    AlteredNestedExecutable,
    WritableMount,
    NetworkMount,
    FuseMount,
    ArbitraryVolumesMount,
}
#[derive(Clone, Copy)]
struct TrustClaims {
    signed: bool,
    ad_hoc: bool,
    team_matches: bool,
    requirement_matches: bool,
    sealed_resources_valid: bool,
    nested_code_valid: bool,
    read_only_mount: bool,
    local_mount: bool,
    apple_disk_image: bool,
    allowed_filesystem: bool,
}
fn validate_claims(claims: TrustClaims) -> Result<(), PackagedTrustError> {
    if claims.signed
        && !claims.ad_hoc
        && claims.team_matches
        && claims.requirement_matches
        && claims.sealed_resources_valid
        && claims.nested_code_valid
        && claims.read_only_mount
        && claims.local_mount
        && claims.apple_disk_image
        && claims.allowed_filesystem
    {
        Ok(())
    } else {
        unavailable()
    }
}
pub fn verify_fixture_with_security_framework_port(
    fixture: TrustFixture,
) -> Result<VerifiedPackagedApp, PackagedTrustError> {
    let mut claims = TrustClaims {
        signed: true,
        ad_hoc: false,
        team_matches: true,
        requirement_matches: true,
        sealed_resources_valid: true,
        nested_code_valid: true,
        read_only_mount: true,
        local_mount: true,
        apple_disk_image: true,
        allowed_filesystem: true,
    };
    match fixture {
        TrustFixture::Unsigned => claims.signed = false,
        TrustFixture::AdHoc => claims.ad_hoc = true,
        TrustFixture::MissingTeamIdentifier => claims.team_matches = false,
        TrustFixture::WrongDesignatedRequirement => claims.requirement_matches = false,
        TrustFixture::AlteredSealedResource => claims.sealed_resources_valid = false,
        TrustFixture::AlteredNestedExecutable => claims.nested_code_valid = false,
        TrustFixture::WritableMount => claims.read_only_mount = false,
        TrustFixture::NetworkMount => claims.local_mount = false,
        TrustFixture::FuseMount => claims.allowed_filesystem = false,
        TrustFixture::ArbitraryVolumesMount => claims.apple_disk_image = false,
    }
    validate_claims(claims)?;
    unavailable()
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    pub(super) fn verify(
        _: &PackagedAppTrustPolicy,
    ) -> Result<VerifiedPackagedApp, PackagedTrustError> {
        unavailable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeMountBackingProbe {
        observation: MountBackingObservation,
        inspected_devices: Mutex<Vec<String>>,
    }

    impl MountBackingProbe for FakeMountBackingProbe {
        fn inspect_backing(
            &self,
            exact_device: &str,
        ) -> Result<MountBackingObservation, PackagedTrustError> {
            self.inspected_devices
                .lock()
                .unwrap()
                .push(exact_device.to_owned());
            Ok(self.observation)
        }
    }

    fn otherwise_valid_mount() -> MountObservation<'static> {
        MountObservation {
            read_only: true,
            local: true,
            under_volumes: true,
            canonical_mount_root: true,
            executable_under_mount: true,
            exact_device: "/dev/disk42s1",
            file_system: "apfs",
        }
    }

    #[test]
    fn physical_local_apfs_is_rejected_without_os_disk_image_backing() {
        let probe = FakeMountBackingProbe {
            observation: MountBackingObservation {
                exact_device_matches: true,
                apple_disk_image_provider: false,
                backing_url_property: false,
                legacy_hdix_provider: false,
            },
            inspected_devices: Mutex::new(Vec::new()),
        };
        assert_eq!(
            validate_mount_observation(otherwise_valid_mount(), &probe),
            Err(PackagedTrustError::NativeLocalActionUnavailable),
        );
        assert_eq!(
            probe.inspected_devices.into_inner().unwrap(),
            vec!["/dev/disk42s1"],
        );
    }

    #[test]
    fn genuine_apple_disk_image_os_fixture_is_accepted() {
        let probe = FakeMountBackingProbe {
            observation: MountBackingObservation {
                exact_device_matches: true,
                apple_disk_image_provider: true,
                backing_url_property: true,
                legacy_hdix_provider: false,
            },
            inspected_devices: Mutex::new(Vec::new()),
        };
        assert_eq!(
            validate_mount_observation(otherwise_valid_mount(), &probe),
            Ok(())
        );
        assert_eq!(
            probe.inspected_devices.into_inner().unwrap(),
            vec!["/dev/disk42s1"],
        );
    }

    #[test]
    fn disk_image_class_without_os_backing_property_is_rejected() {
        let probe = FakeMountBackingProbe {
            observation: MountBackingObservation {
                exact_device_matches: true,
                apple_disk_image_provider: true,
                backing_url_property: false,
                legacy_hdix_provider: false,
            },
            inspected_devices: Mutex::new(Vec::new()),
        };
        assert_eq!(
            validate_mount_observation(otherwise_valid_mount(), &probe),
            Err(PackagedTrustError::NativeLocalActionUnavailable),
        );
    }

    #[test]
    fn disk_image_facts_for_another_device_are_rejected() {
        let probe = FakeMountBackingProbe {
            observation: MountBackingObservation {
                exact_device_matches: false,
                apple_disk_image_provider: true,
                backing_url_property: true,
                legacy_hdix_provider: false,
            },
            inspected_devices: Mutex::new(Vec::new()),
        };
        assert_eq!(
            validate_mount_observation(otherwise_valid_mount(), &probe),
            Err(PackagedTrustError::NativeLocalActionUnavailable),
        );
    }

    #[test]
    fn verified_fixture_retains_the_canonical_team_identifier() {
        let verified = verified_packaged_app_fixture(
            "/Volumes/Orcode/Orcode.app/Contents/MacOS/orcode-gui",
            1,
            2,
            3,
            "ABCDE12345",
            [1; 32],
            [2; 32],
        )
        .expect("fixture");
        assert_eq!(verified.team_identifier, "ABCDE12345");
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::ptr;
    type CFRef = *const c_void;
    type CodeRef = *const c_void;
    type IoObject = u32;
    const UTF8: u32 = 0x0800_0100;
    // SecCSFlags: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate.
    const VALIDATE: u32 = (1 << 0) | (1 << 3) | (1 << 4);
    const SIGNING_INFO: u32 = 1 << 1;
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecCodeCopySelf(flags: u32, out: *mut CodeRef) -> i32;
        fn SecCodeCheckValidityWithErrors(
            code: CodeRef,
            flags: u32,
            req: CFRef,
            error: *mut CFRef,
        ) -> i32;
        fn SecCodeCopySigningInformation(code: CodeRef, flags: u32, out: *mut CFRef) -> i32;
        fn SecCodeCopyDesignatedRequirement(code: CodeRef, flags: u32, out: *mut CFRef) -> i32;
        fn SecRequirementCopyData(req: CFRef, flags: u32, out: *mut CFRef) -> i32;
        fn SecRequirementCreateWithString(text: CFRef, flags: u32, out: *mut CFRef) -> i32;
        fn SecStaticCodeCreateWithPath(path: CFRef, flags: u32, out: *mut CodeRef) -> i32;
        fn SecStaticCodeCheckValidityWithErrors(
            code: CodeRef,
            flags: u32,
            req: CFRef,
            error: *mut CFRef,
        ) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(v: CFRef);
        fn CFURLCreateFromFileSystemRepresentation(
            a: CFRef,
            b: *const u8,
            n: isize,
            d: bool,
        ) -> CFRef;
        fn CFStringCreateWithCString(a: CFRef, v: *const c_char, e: u32) -> CFRef;
        fn CFStringGetCString(v: CFRef, b: *mut c_char, n: isize, e: u32) -> bool;
        fn CFDictionaryGetValue(d: CFRef, k: CFRef) -> CFRef;
        fn CFNumberGetValue(v: CFRef, t: i32, out: *mut c_void) -> bool;
        fn CFDataGetLength(d: CFRef) -> isize;
        fn CFDataGetBytePtr(d: CFRef) -> *const u8;
    }
    #[link(name = "DiskArbitration", kind = "framework")]
    extern "C" {
        fn DASessionCreate(allocator: CFRef) -> CFRef;
        fn DADiskCreateFromBSDName(allocator: CFRef, session: CFRef, name: *const c_char) -> CFRef;
        fn DADiskGetBSDName(disk: CFRef) -> *const c_char;
        fn DADiskCopyIOMedia(disk: CFRef) -> IoObject;
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOObjectConformsTo(object: IoObject, class_name: *const c_char) -> u32;
        fn IOObjectRelease(object: IoObject) -> i32;
        fn IORegistryEntryGetParentEntry(
            entry: IoObject,
            plane: *const c_char,
            parent: *mut IoObject,
        ) -> i32;
        fn IORegistryEntryCreateCFProperty(
            entry: IoObject,
            key: CFRef,
            allocator: CFRef,
            options: u32,
        ) -> CFRef;
    }
    struct Owned(CFRef);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }
    struct OwnedIo(IoObject);
    impl Drop for OwnedIo {
        fn drop(&mut self) {
            if self.0 != 0 {
                unsafe {
                    IOObjectRelease(self.0);
                }
            }
        }
    }

    struct DarwinMountBackingProbe;
    impl MountBackingProbe for DarwinMountBackingProbe {
        fn inspect_backing(
            &self,
            exact_device: &str,
        ) -> Result<MountBackingObservation, PackagedTrustError> {
            unsafe { inspect_apple_disk_image_backing(exact_device) }
        }
    }
    fn ok(code: i32) -> Result<(), PackagedTrustError> {
        if code == 0 {
            Ok(())
        } else {
            unavailable()
        }
    }

    pub(super) fn verify(
        policy: &PackagedAppTrustPolicy,
    ) -> Result<VerifiedPackagedApp, PackagedTrustError> {
        let raw = std::env::current_exe()
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        if std::fs::symlink_metadata(&raw)
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?
            .file_type()
            .is_symlink()
        {
            return unavailable();
        }
        let exe = std::fs::canonicalize(raw)
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let app = exe
            .ancestors()
            .find(|p| p.extension().is_some_and(|v| v == "app"))
            .ok_or(PackagedTrustError::NativeLocalActionUnavailable)?;
        if !exe.starts_with(app.join("Contents/MacOS")) {
            return unavailable();
        }
        if !read_only_dmg_mount(&exe)? {
            return unavailable();
        }
        let plist = plist::Value::from_file(app.join("Contents/Info.plist"))
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let dict = plist
            .as_dictionary()
            .ok_or(PackagedTrustError::NativeLocalActionUnavailable)?;
        if dict
            .get("CFBundleIdentifier")
            .and_then(plist::Value::as_string)
            != Some(policy.bundle_identifier)
            || dict
                .get("CFBundleShortVersionString")
                .and_then(plist::Value::as_string)
                != Some(policy.product_version)
        {
            return unavailable();
        }
        unsafe {
            let required = requirement(policy)?;
            let mut current = ptr::null();
            ok(SecCodeCopySelf(0, &mut current))?;
            let current = Owned(current);
            ok(SecCodeCheckValidityWithErrors(
                current.0,
                VALIDATE,
                required.0,
                ptr::null_mut(),
            ))?;
            identity(current.0, policy)?;
            for path in [app, &exe] {
                let code = static_code(path)?;
                ok(SecStaticCodeCheckValidityWithErrors(
                    code.0,
                    VALIDATE,
                    required.0,
                    ptr::null_mut(),
                ))?;
                identity(code.0, policy)?;
            }
            let mut req = ptr::null();
            ok(SecCodeCopyDesignatedRequirement(current.0, 0, &mut req))?;
            let req = Owned(req);
            let mut data = ptr::null();
            ok(SecRequirementCopyData(req.0, 0, &mut data))?;
            let data = Owned(data);
            let n = CFDataGetLength(data.0);
            if n <= 0 {
                return unavailable();
            }
            let bytes = std::slice::from_raw_parts(CFDataGetBytePtr(data.0), n as usize);
            if Sha256::digest(bytes).as_slice() != policy.designated_requirement_sha256 {
                return unavailable();
            }
        }
        hash(&exe, policy.team_identifier, policy.policy_sha256)
    }
    fn read_only_dmg_mount(path: &std::path::Path) -> Result<bool, PackagedTrustError> {
        let c = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let mut info = std::mem::MaybeUninit::<libc::statfs>::zeroed();
        if unsafe { libc::statfs(c.as_ptr(), info.as_mut_ptr()) } != 0 {
            return unavailable();
        }
        let info = unsafe { info.assume_init() };
        let mount =
            unsafe { std::ffi::CStr::from_ptr(info.f_mntonname.as_ptr()) }.to_string_lossy();
        let backing =
            unsafe { std::ffi::CStr::from_ptr(info.f_mntfromname.as_ptr()) }.to_string_lossy();
        let fs = unsafe { std::ffi::CStr::from_ptr(info.f_fstypename.as_ptr()) }.to_string_lossy();
        let root = std::path::Path::new(mount.as_ref());
        let canonical_root = std::fs::canonicalize(root)
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        validate_mount_observation(
            MountObservation {
                read_only: (info.f_flags as u64 & libc::MNT_RDONLY as u64) != 0,
                local: (info.f_flags as u64 & libc::MNT_LOCAL as u64) != 0,
                under_volumes: canonical_root.parent() == Some(std::path::Path::new("/Volumes")),
                canonical_mount_root: canonical_root == root,
                executable_under_mount: path.starts_with(&canonical_root),
                exact_device: backing.as_ref(),
                file_system: fs.as_ref(),
            },
            &DarwinMountBackingProbe,
        )?;
        Ok(true)
    }

    unsafe fn inspect_apple_disk_image_backing(
        exact_device: &str,
    ) -> Result<MountBackingObservation, PackagedTrustError> {
        let unverified = || MountBackingObservation {
            exact_device_matches: false,
            apple_disk_image_provider: false,
            backing_url_property: false,
            legacy_hdix_provider: false,
        };
        let Some(bsd_name) = exact_device.strip_prefix("/dev/") else {
            return Ok(unverified());
        };
        if bsd_name.is_empty() || bsd_name.as_bytes().contains(&b'/') {
            return Ok(unverified());
        }
        let exact_device = CString::new(exact_device)
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let session = Owned(DASessionCreate(ptr::null()));
        if session.0.is_null() {
            return unavailable();
        }
        let disk = Owned(DADiskCreateFromBSDName(
            ptr::null(),
            session.0,
            exact_device.as_ptr(),
        ));
        if disk.0.is_null() {
            return Ok(unverified());
        }
        let reported = DADiskGetBSDName(disk.0);
        let exact_device_matches =
            !reported.is_null() && CStr::from_ptr(reported).to_bytes() == bsd_name.as_bytes();
        if !exact_device_matches {
            return Ok(unverified());
        }
        let media = DADiskCopyIOMedia(disk.0);
        if media == 0 {
            return Ok(unverified());
        }
        let mut entry = OwnedIo(media);
        let io_service_plane = b"IOService\0";
        let mut observation = MountBackingObservation {
            exact_device_matches,
            apple_disk_image_provider: false,
            backing_url_property: false,
            legacy_hdix_provider: false,
        };
        for _ in 0..64 {
            inspect_apple_disk_image_node(entry.0, &mut observation)?;
            if observation.is_apple_disk_image() {
                return Ok(observation);
            }
            let mut parent = 0;
            if IORegistryEntryGetParentEntry(entry.0, io_service_plane.as_ptr().cast(), &mut parent)
                != 0
                || parent == 0
            {
                return Ok(observation);
            }
            entry = OwnedIo(parent);
        }
        Ok(observation)
    }

    unsafe fn inspect_apple_disk_image_node(
        entry: IoObject,
        observation: &mut MountBackingObservation,
    ) -> Result<(), PackagedTrustError> {
        let modern = CString::new("AppleDiskImageDevice")
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        if IOObjectConformsTo(entry, modern.as_ptr()) != 0 {
            observation.apple_disk_image_provider = true;
            observation.backing_url_property |= io_registry_property_exists(entry, "DiskImageURL")?;
        }
        let legacy = CString::new("IOHDIXHDDrive")
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        observation.legacy_hdix_provider |= IOObjectConformsTo(entry, legacy.as_ptr()) != 0;
        Ok(())
    }

    unsafe fn io_registry_property_exists(
        entry: IoObject,
        name: &str,
    ) -> Result<bool, PackagedTrustError> {
        let name =
            CString::new(name).map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let key = Owned(CFStringCreateWithCString(ptr::null(), name.as_ptr(), UTF8));
        if key.0.is_null() {
            return unavailable();
        }
        let value = Owned(IORegistryEntryCreateCFProperty(
            entry,
            key.0,
            ptr::null(),
            0,
        ));
        Ok(!value.0.is_null())
    }
    unsafe fn requirement(policy: &PackagedAppTrustPolicy) -> Result<Owned, PackagedTrustError> {
        let source = format!(
            "identifier \"{}\" and anchor apple generic and certificate leaf[subject.OU] = \"{}\"",
            policy.bundle_identifier, policy.team_identifier
        );
        let c =
            CString::new(source).map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let text = Owned(CFStringCreateWithCString(ptr::null(), c.as_ptr(), UTF8));
        if text.0.is_null() {
            return unavailable();
        }
        let mut req = ptr::null();
        ok(SecRequirementCreateWithString(text.0, 0, &mut req))?;
        Ok(Owned(req))
    }
    unsafe fn static_code(path: &std::path::Path) -> Result<Owned, PackagedTrustError> {
        let b = path.as_os_str().as_bytes();
        let url = Owned(CFURLCreateFromFileSystemRepresentation(
            ptr::null(),
            b.as_ptr(),
            b.len() as isize,
            path.is_dir(),
        ));
        if url.0.is_null() {
            return unavailable();
        }
        let mut code = ptr::null();
        ok(SecStaticCodeCreateWithPath(url.0, 0, &mut code))?;
        Ok(Owned(code))
    }
    unsafe fn identity(
        code: CodeRef,
        p: &PackagedAppTrustPolicy,
    ) -> Result<(), PackagedTrustError> {
        let mut info = ptr::null();
        ok(SecCodeCopySigningInformation(code, SIGNING_INFO, &mut info))?;
        let info = Owned(info);
        if string(info.0, "teamid")? != p.team_identifier
            || string(info.0, "identifier")? != p.bundle_identifier
            || number(info.0, "flags")? & 2 != 0
        {
            return unavailable();
        }
        Ok(())
    }
    unsafe fn string(dict: CFRef, name: &str) -> Result<String, PackagedTrustError> {
        let n = CString::new(name).map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let key = Owned(CFStringCreateWithCString(ptr::null(), n.as_ptr(), UTF8));
        let value = CFDictionaryGetValue(dict, key.0);
        if value.is_null() {
            return unavailable();
        }
        let mut b = [0_i8; 512];
        if !CFStringGetCString(value, b.as_mut_ptr(), b.len() as isize, UTF8) {
            return unavailable();
        }
        Ok(std::ffi::CStr::from_ptr(b.as_ptr())
            .to_string_lossy()
            .into_owned())
    }
    unsafe fn number(dict: CFRef, name: &str) -> Result<u32, PackagedTrustError> {
        let n = CString::new(name).map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let key = Owned(CFStringCreateWithCString(ptr::null(), n.as_ptr(), UTF8));
        let value = CFDictionaryGetValue(dict, key.0);
        if value.is_null() {
            return unavailable();
        }
        let mut out = 0_u32;
        if !CFNumberGetValue(value, 3, &mut out as *mut u32 as *mut c_void) {
            return unavailable();
        }
        Ok(out)
    }
    fn hash(
        path: &std::path::Path,
        team: &str,
        policy: [u8; 32],
    ) -> Result<VerifiedPackagedApp, PackagedTrustError> {
        let c = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let fd = unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return unavailable();
        }
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let m = file
            .metadata()
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        let mut h = Sha256::new();
        std::io::copy(&mut file, &mut h)
            .map_err(|_| PackagedTrustError::NativeLocalActionUnavailable)?;
        Ok(VerifiedPackagedApp {
            executable_path: path.into(),
            executable_device: m.dev(),
            executable_inode: m.ino(),
            executable_size: m.size(),
            team_identifier: team.into(),
            executable_sha256: h.finalize().into(),
            policy_sha256: policy,
        })
    }
}
