import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES = 16 * 1_024 * 1_024;
const PRIVATE_STORE_CLAIM_PAYLOAD_AUTHORITY = Object.freeze([
  "before-config.json",
  "after-config.json",
  "before-session.json",
  "after-session.json",
] as const);
export type PrivateStoreClaimPayloadName =
  (typeof PRIVATE_STORE_CLAIM_PAYLOAD_AUTHORITY)[number];
export const PRIVATE_STORE_CLAIM_PAYLOAD_NAMES = Object.freeze([
  ...PRIVATE_STORE_CLAIM_PAYLOAD_AUTHORITY,
] as const);

const PRIVATE_STORE_CLAIM_PAYLOAD_NAME_SET: ReadonlySet<string> = new Set(
  PRIVATE_STORE_CLAIM_PAYLOAD_AUTHORITY,
);

export interface PrivateStoreProtectionIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly kind: "directory" | "file";
}

export interface PrivateStoreAdapter {
  readonly name: string;
  available(): Promise<boolean>;
  protectDirectory(
    path: string,
    handle?: FileHandle,
    identity?: PrivateStoreProtectionIdentity,
  ): Promise<void>;
  protectFile(
    path: string,
    handle?: FileHandle,
    identity?: PrivateStoreProtectionIdentity,
  ): Promise<void>;
}

export class PosixPrivateStoreAdapter implements PrivateStoreAdapter {
  readonly name = "posix-0700-0600";

  async available(): Promise<boolean> {
    return true;
  }

  async protectDirectory(
    path: string,
    handle?: FileHandle,
    _identity?: PrivateStoreProtectionIdentity,
  ): Promise<void> {
    if (handle) await handle.chmod(PRIVATE_DIRECTORY_MODE);
    else await chmod(path, PRIVATE_DIRECTORY_MODE);
  }

  async protectFile(
    path: string,
    handle?: FileHandle,
    _identity?: PrivateStoreProtectionIdentity,
  ): Promise<void> {
    if (handle) await handle.chmod(PRIVATE_FILE_MODE);
    else await chmod(path, PRIVATE_FILE_MODE);
  }
}

export interface PrivateStoreProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PrivateStoreProcessOptions {
  environment?: Readonly<Record<string, string>>;
}

export type PrivateStoreProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: PrivateStoreProcessOptions,
) => Promise<PrivateStoreProcessResult>;

const WINDOWS_DACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:ORCODE_PRIVATE_PATH
$kind = $env:ORCODE_PRIVATE_KIND
$expectedDevText = $env:ORCODE_PRIVATE_EXPECTED_DEV
$expectedInoText = $env:ORCODE_PRIVATE_EXPECTED_INO
if ([string]::IsNullOrEmpty($path) -or
    ($kind -ne 'directory' -and $kind -ne 'file') -or
    [string]::IsNullOrEmpty($expectedDevText) -or
    [string]::IsNullOrEmpty($expectedInoText)) { exit 16 }
[UInt64]$expectedDev = 0
[UInt64]$expectedIno = 0
if (-not [UInt64]::TryParse($expectedDevText, [ref]$expectedDev) -or
    -not [UInt64]::TryParse($expectedInoText, [ref]$expectedIno)) { exit 16 }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class OrcodePrivateAcl {
  private const uint ReadControl = 0x00020000;
  private const uint WriteDac = 0x00040000;
  private const uint ShareRead = 0x00000001;
  private const uint ShareWrite = 0x00000002;
  private const uint ShareDelete = 0x00000004;
  private const uint OpenExisting = 3;
  private const uint FileFlagBackupSemantics = 0x02000000;
  private const uint FileFlagOpenReparsePoint = 0x00200000;
  private const uint FileAttributeDirectory = 0x00000010;
  private const uint FileAttributeReparsePoint = 0x00000400;
  private const uint DaclSecurityInformation = 0x00000004;
  private const uint ProtectedDaclSecurityInformation = 0x80000000;
  private const int SeFileObject = 1;
  private const int FullControl = 0x001F01FF;

  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime {
    public uint Low;
    public uint High;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ByHandleFileInformation {
    public uint FileAttributes;
    public FileTime CreationTime;
    public FileTime LastAccessTime;
    public FileTime LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle file,
    out ByHandleFileInformation information);

  [DllImport("advapi32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetSecurityDescriptorDacl(
    IntPtr securityDescriptor,
    [MarshalAs(UnmanagedType.Bool)] out bool daclPresent,
    out IntPtr dacl,
    [MarshalAs(UnmanagedType.Bool)] out bool daclDefaulted);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint SetSecurityInfo(
    SafeFileHandle handle,
    int objectType,
    uint securityInformation,
    IntPtr owner,
    IntPtr group,
    IntPtr dacl,
    IntPtr sacl);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint GetSecurityInfo(
    SafeFileHandle handle,
    int objectType,
    uint securityInformation,
    out IntPtr owner,
    out IntPtr group,
    out IntPtr dacl,
    out IntPtr sacl,
    out IntPtr securityDescriptor);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);

  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);

  public static int Protect(string path, string kind, ulong expectedDev, ulong expectedIno) {
    bool expectDirectory = kind == "directory";
    using (SafeFileHandle handle = CreateFileW(
      path,
      ReadControl | WriteDac,
      ShareRead | ShareWrite | ShareDelete,
      IntPtr.Zero,
      OpenExisting,
      FileFlagBackupSemantics | FileFlagOpenReparsePoint,
      IntPtr.Zero)) {
      if (handle.IsInvalid) return 20;
      ByHandleFileInformation information;
      if (!GetFileInformationByHandle(handle, out information)) return 21;
      bool isDirectory = (information.FileAttributes & FileAttributeDirectory) != 0;
      bool isReparsePoint = (information.FileAttributes & FileAttributeReparsePoint) != 0;
      ulong fileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
      if (isReparsePoint || isDirectory != expectDirectory ||
          information.VolumeSerialNumber != expectedDev || fileIndex != expectedIno) return 18;

      SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
      if (user == null) return 22;
      SecurityIdentifier system = new SecurityIdentifier("S-1-5-18");
      AceFlags flags = expectDirectory
        ? AceFlags.ContainerInherit | AceFlags.ObjectInherit
        : AceFlags.None;
      RawAcl acl = new RawAcl(GenericAcl.AclRevision, 2);
      acl.InsertAce(0, new CommonAce(flags, AceQualifier.AccessAllowed, FullControl, user, false, null));
      acl.InsertAce(1, new CommonAce(flags, AceQualifier.AccessAllowed, FullControl, system, false, null));
      RawSecurityDescriptor descriptor = new RawSecurityDescriptor(
        ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected,
        null,
        null,
        null,
        acl);
      byte[] binary = new byte[descriptor.BinaryLength];
      descriptor.GetBinaryForm(binary, 0);
      GCHandle pinned = GCHandle.Alloc(binary, GCHandleType.Pinned);
      try {
        bool present;
        bool defaulted;
        IntPtr dacl;
        if (!GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(), out present, out dacl, out defaulted)
            || !present || dacl == IntPtr.Zero) return 23;
        uint setResult = SetSecurityInfo(
          handle,
          SeFileObject,
          DaclSecurityInformation | ProtectedDaclSecurityInformation,
          IntPtr.Zero,
          IntPtr.Zero,
          dacl,
          IntPtr.Zero);
        if (setResult != 0) return unchecked((int)setResult);
      } finally {
        pinned.Free();
      }

      IntPtr owner;
      IntPtr group;
      IntPtr verifiedDacl;
      IntPtr sacl;
      IntPtr verifiedDescriptor;
      uint getResult = GetSecurityInfo(
        handle,
        SeFileObject,
        DaclSecurityInformation,
        out owner,
        out group,
        out verifiedDacl,
        out sacl,
        out verifiedDescriptor);
      if (getResult != 0) return unchecked((int)getResult);
      try {
        uint length = GetSecurityDescriptorLength(verifiedDescriptor);
        if (length == 0 || length > Int32.MaxValue) return 24;
        byte[] verifiedBinary = new byte[(int)length];
        Marshal.Copy(verifiedDescriptor, verifiedBinary, 0, verifiedBinary.Length);
        RawSecurityDescriptor verified = new RawSecurityDescriptor(verifiedBinary, 0);
        if ((verified.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
            verified.DiscretionaryAcl == null || verified.DiscretionaryAcl.Count != 2) return 17;
        HashSet<string> expectedSids = new HashSet<string>(StringComparer.Ordinal) {
          user.Value,
          system.Value,
        };
        foreach (GenericAce genericAce in verified.DiscretionaryAcl) {
          CommonAce ace = genericAce as CommonAce;
          if (ace == null || ace.AceQualifier != AceQualifier.AccessAllowed ||
              ace.AccessMask != FullControl || ace.AceFlags != flags ||
              !expectedSids.Remove(ace.SecurityIdentifier.Value)) return 17;
        }
        return expectedSids.Count == 0 ? 0 : 17;
      } finally {
        if (verifiedDescriptor != IntPtr.Zero) LocalFree(verifiedDescriptor);
      }
    }
  }
}
'@

$result = [OrcodePrivateAcl]::Protect($path, $kind, $expectedDev, $expectedIno)
exit $result
`;
const WINDOWS_DACL_ENCODED = Buffer.from(WINDOWS_DACL_SCRIPT, "utf16le").toString("base64");

export class WindowsPrivateStoreAdapter implements PrivateStoreAdapter {
  readonly name = "windows-current-user-system-dacl";

  constructor(private readonly run: PrivateStoreProcessRunner = runPrivateStoreProcess) {}

  async available(): Promise<boolean> {
    let probeDirectory: string | null = null;
    let probeFile: string | null = null;
    try {
      probeDirectory = await mkdtemp(join(tmpdir(), "orcode-private-dacl-probe-"));
      await this.protectDirectory(probeDirectory);
      probeFile = join(probeDirectory, "probe.bin");
      await writeFile(probeFile, "", { flag: "wx", mode: PRIVATE_FILE_MODE });
      await this.protectFile(probeFile);
      return true;
    } catch {
      return false;
    } finally {
      if (probeFile) await unlink(probeFile).catch(() => undefined);
      if (probeDirectory) await rmdir(probeDirectory).catch(() => undefined);
    }
  }

  async protectDirectory(
    path: string,
    _handle?: FileHandle,
    identity?: PrivateStoreProtectionIdentity,
  ): Promise<void> {
    await this.protect(path, "directory", identity);
  }

  async protectFile(
    path: string,
    _handle?: FileHandle,
    identity?: PrivateStoreProtectionIdentity,
  ): Promise<void> {
    await this.protect(path, "file", identity);
  }

  private async protect(
    path: string,
    kind: "directory" | "file",
    suppliedIdentity?: PrivateStoreProtectionIdentity,
  ): Promise<void> {
    const identity = suppliedIdentity ?? await protectionIdentity(path, kind);
    if (identity.kind !== kind) {
      throw new Error(`PrivateStore-DACL erhielt eine falsche Objektart für ${path}.`);
    }
    const result = await this.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_DACL_ENCODED,
    ], {
      environment: {
        ORCODE_PRIVATE_PATH: path,
        ORCODE_PRIVATE_KIND: kind,
        ORCODE_PRIVATE_EXPECTED_DEV: identity.dev.toString(),
        ORCODE_PRIVATE_EXPECTED_INO: identity.ino.toString(),
      },
    });
    if (result.code !== 0) {
      throw new Error(
        `PrivateStore-DACL konnte für ${path} nicht verifiziert werden (${result.stderr.trim() || `Exit ${result.code}`}).`,
      );
    }
  }
}

export interface PrivateStoreOptions {
  adapter?: PrivateStoreAdapter;
  /** Trusted storage boundary. The root itself and every descendant component must be a real directory. */
  root?: string;
}

interface PathIdentity extends PrivateStoreProtectionIdentity {
  path: string;
}

const PRIVATE_DIRECTORY_CLAIM_IDENTITY: unique symbol = Symbol(
  "PrivateStore.directory-claim-identity",
);

interface PrivateDirectoryClaimState {
  readonly owner: object;
  readonly ancestors: readonly PathIdentity[];
  readonly directory: PathIdentity;
  readonly modifiedAtMs: number;
}

/** Opaque proof that this process created and protected one exact directory. */
export interface PrivateDirectoryClaim {
  readonly [PRIVATE_DIRECTORY_CLAIM_IDENTITY]: PrivateDirectoryClaimState;
}

/**
 * Fail-closed boundary for exact recovery data. Content reaches a file only
 * after the directory and empty exclusive temp file have private permissions.
 */
export class PrivateStore {
  readonly adapter: PrivateStoreAdapter;
  readonly #root: string | null;
  readonly #claimOwner = Object.freeze({});
  #availability: Promise<boolean> | null = null;

  constructor(options: PrivateStoreOptions = {}) {
    this.adapter = options.adapter ?? (
      process.platform === "win32"
        ? new WindowsPrivateStoreAdapter()
        : new PosixPrivateStoreAdapter()
    );
    this.#root = options.root ? resolve(options.root) : null;
  }

  async available(): Promise<boolean> {
    this.#availability ??= this.adapter.available().catch(() => false);
    return this.#availability;
  }

  async assertAvailable(): Promise<void> {
    if (!(await this.available())) {
      throw new Error(`PrivateStore (${this.adapter.name}) ist nicht verfügbar; exakte Daten werden nicht geschrieben.`);
    }
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.assertAvailable();
    const target = resolve(path);
    const root = this.#root ?? target;
    await ensurePrivateDirectoryTree(root, target, this.adapter);
  }

  /**
   * Atomically reserves one real, private directory beneath the verified root.
   * Existing real directories are reported as a lost race; links and identity
   * changes fail closed. Task 3 deliberately has no path-based release API for
   * this claim. A future release must consume and revalidate the opaque token.
   */
  async createDirectoryExclusive(path: string): Promise<PrivateDirectoryClaim | null> {
    await this.assertAvailable();
    const target = resolve(path);
    const root = this.#root ?? dirname(target);
    assertContained(root, target);
    if (target === root) {
      throw new Error(`PrivateStore reserviert seine eigene Root-Grenze nicht: ${target}`);
    }
    const ensuredRoot = this.#root === null
      ? null
      : await ensureExclusiveClaimRoot(root, this.adapter);
    const ancestors = await directoryIdentities(root, dirname(target));
    if (ensuredRoot !== null) {
      const capturedRoot = ancestors[0];
      if (!capturedRoot) {
        throw new Error(`PrivateStore-Claim-Root wurde nicht gebunden: ${root}`);
      }
      assertSameIdentity(ensuredRoot, capturedRoot, root);
    }
    await assertDirectoryIdentities(ancestors);
    try {
      await mkdir(target, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      await assertDirectoryIdentities(ancestors);
      const existing = await lstat(target, { bigint: true });
      await assertDirectoryIdentities(ancestors);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(`PrivateStore-Lease ist kein echtes Verzeichnis: ${target}`);
      }
      return null;
    }

    await assertDirectoryIdentities(ancestors);
    const info = await lstat(target, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`PrivateStore-Lease wurde bei der Erstellung ausgetauscht: ${target}`);
    }
    const created = pathIdentity(target, info, "directory");
    const protectedIdentity = await protectBoundPath(
      target,
      "directory",
      this.adapter,
      ancestors,
      created,
    );
    assertSameIdentity(created, protectedIdentity, target);
    await assertDirectoryIdentities(ancestors);
    await assertPathIdentity(protectedIdentity);
    return this.#claimToken(ancestors, protectedIdentity, Number(info.mtimeMs));
  }

  /**
   * Binds an existing exact directory for stale-lease inspection. This is
   * read-only: it never protects, creates, removes, or normalizes the path.
   */
  async adoptDirectoryClaim(
    path: string,
  ): Promise<{ claim: PrivateDirectoryClaim; modifiedAtMs: number }> {
    await this.assertAvailable();
    const target = resolve(path);
    const root = this.#root ?? dirname(target);
    assertContained(root, target);
    if (target === root) {
      throw new Error(`PrivateStore bindet seine eigene Root-Grenze nicht als Claim: ${target}`);
    }
    const ancestors = await directoryIdentities(root, dirname(target));
    await assertDirectoryIdentities(ancestors);
    const before = await lstat(target, { bigint: true });
    await assertDirectoryIdentities(ancestors);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(`PrivateStore-Claim ist kein echtes Verzeichnis: ${target}`);
    }
    const expected = pathIdentity(target, before, "directory");
    const handle = await openIdentityHandle(target, "directory");
    let directory = expected;
    try {
      await assertDirectoryIdentities(ancestors);
      if (handle) {
        directory = await assertHandlePathIdentity(handle, target, "directory");
        assertSameIdentity(expected, directory, target);
      } else {
        await assertPathIdentity(expected);
      }
      await assertDirectoryIdentities(ancestors);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    await assertDirectoryIdentities(ancestors);
    await assertPathIdentity(directory);
    const modifiedAtMs = Number(before.mtimeMs);
    return {
      claim: this.#claimToken(ancestors, directory, modifiedAtMs),
      modifiedAtMs,
    };
  }

  /** Revalidates the root, ancestors, and exact claimed inode. */
  async assertDirectoryClaim(claim: PrivateDirectoryClaim): Promise<void> {
    const state = this.#claimState(claim);
    await assertDirectoryIdentities(state.ancestors);
    await assertPathIdentity(state.directory);
    await assertDirectoryIdentities(state.ancestors);
    await assertPathIdentity(state.directory);
  }

  /** Writes only the fixed lease owner file, once, through the opaque claim. */
  async writeClaimOwner(claim: PrivateDirectoryClaim, content: string): Promise<void> {
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 4_096) {
      throw new Error("PrivateStore-Claim-Owner ist ungültig oder zu groß.");
    }
    const state = this.#claimState(claim);
    const ownerPath = join(state.directory.path, "owner.json");
    const tree = [...state.ancestors, state.directory];
    let handle: FileHandle | null = null;
    let ownerIdentity: PathIdentity | null = null;
    try {
      await this.assertDirectoryClaim(claim);
      handle = await open(ownerPath, "wx", PRIVATE_FILE_MODE);
      await this.assertDirectoryClaim(claim);
      ownerIdentity = await assertHandlePathIdentity(handle, ownerPath, "file");
      await protectOpenPath(
        handle,
        ownerPath,
        "file",
        this.adapter,
        tree,
        ownerIdentity,
      );
      await this.assertDirectoryClaim(claim);
      await handle.writeFile(content, "utf8");
      await this.assertDirectoryClaim(claim);
      await handle.sync();
      await this.assertDirectoryClaim(claim);
      ownerIdentity = await assertHandlePathIdentity(handle, ownerPath, "file");
    } catch (error) {
      await unlinkBoundTemporary(ownerIdentity, tree, handle);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    await this.assertDirectoryClaim(claim);
    if (!ownerIdentity) {
      throw new Error("PrivateStore-Claim-Owner wurde nicht gebunden.");
    }
    await assertPathIdentity(ownerIdentity);
  }

  /** Reads only owner.json with a no-follow handle and bounded size. */
  async readClaimOwner(
    claim: PrivateDirectoryClaim,
    maxBytes = 4_096,
  ): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) {
      throw new Error("PrivateStore-Claim-Owner-Limit ist ungültig.");
    }
    const state = this.#claimState(claim);
    const ownerPath = join(state.directory.path, "owner.json");
    let handle: FileHandle | null = null;
    try {
      await this.assertDirectoryClaim(claim);
      handle = await openIdentityHandle(ownerPath, "file");
      if (!handle) throw new Error("PrivateStore-Claim-Owner konnte nicht gebunden werden.");
      await this.assertDirectoryClaim(claim);
      const identity = await assertHandlePathIdentity(handle, ownerPath, "file");
      await this.assertDirectoryClaim(claim);
      const info = await handle.stat({ bigint: true });
      await this.assertDirectoryClaim(claim);
      if (info.size > BigInt(maxBytes)) {
        throw new Error("PrivateStore-Claim-Owner ist zu groß.");
      }
      const content = await handle.readFile("utf8");
      await this.assertDirectoryClaim(claim);
      const current = await assertHandlePathIdentity(handle, ownerPath, "file");
      assertSameIdentity(identity, current, ownerPath);
      return content;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * Creates one fixed transaction payload exactly once through the opaque
   * directory claim. Callers cannot supply a path or an arbitrary filename.
   */
  async writeClaimPayload(
    claim: PrivateDirectoryClaim,
    name: PrivateStoreClaimPayloadName,
    content: string,
  ): Promise<void> {
    assertClaimPayloadName(name);
    const expectedBytes = typeof content === "string" ? Buffer.from(content, "utf8") : null;
    if (!expectedBytes
      || expectedBytes.byteLength > PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES) {
      throw new Error("PrivateStore-Claim-Payload ist ungültig oder zu groß.");
    }
    const state = this.#claimState(claim);
    const before = await this.#claimFileIdentities(claim);
    assertPayloadEntrySet(before, { manifest: "forbidden", payloads: "partial" });
    const payloadPath = join(state.directory.path, name);
    const tree = [...state.ancestors, state.directory];
    const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
    let handle: FileHandle | null = null;
    let payloadIdentity: PathIdentity | null = null;
    try {
      await this.assertDirectoryClaim(claim);
      handle = await open(
        payloadPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
        PRIVATE_FILE_MODE,
      );
      await this.assertDirectoryClaim(claim);
      payloadIdentity = await assertHandlePathIdentity(handle, payloadPath, "file");
      await protectOpenPath(
        handle,
        payloadPath,
        "file",
        this.adapter,
        tree,
        payloadIdentity,
      );
      await this.assertDirectoryClaim(claim);
      await handle.writeFile(expectedBytes);
      await this.assertDirectoryClaim(claim);
      await handle.sync();
      await this.assertDirectoryClaim(claim);
      const info = await handle.stat({ bigint: true });
      if (info.size !== BigInt(expectedBytes.byteLength)) {
        throw new Error("PrivateStore-Claim-Payload stimmt nach dem Schreiben nicht überein.");
      }
      const current = await assertHandlePathIdentity(handle, payloadPath, "file");
      assertSameIdentity(payloadIdentity, current, payloadPath);
      const entries = await this.#claimFileIdentities(claim);
      assertPayloadEntrySet(entries, { manifest: "forbidden", payloads: "partial" });
      const publishedIdentity = entries.get(name);
      if (!publishedIdentity) {
        throw new Error("PrivateStore-Claim-Payload wurde nicht gebunden.");
      }
      assertSameIdentity(payloadIdentity, publishedIdentity, payloadPath);
      const readback = await this.#readClaimPayloadBytes(
        claim,
        name,
        PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES,
      );
      if (!readback.equals(expectedBytes)) {
        throw new Error("PrivateStore-Claim-Payload stimmt nach dem Schreiben nicht überein.");
      }
    } catch (error) {
      await unlinkBoundTemporary(payloadIdentity, tree, handle);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Reads one fixed payload through a no-follow handle with an exact size cap. */
  async readClaimPayload(
    claim: PrivateDirectoryClaim,
    name: PrivateStoreClaimPayloadName,
    maxBytes = PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES,
  ): Promise<string> {
    const bytes = await this.#readClaimPayloadBytes(claim, name, maxBytes);
    return decodeCanonicalClaimPayloadUtf8(bytes);
  }

  async #readClaimPayloadBytes(
    claim: PrivateDirectoryClaim,
    name: PrivateStoreClaimPayloadName,
    maxBytes: number,
  ): Promise<Buffer> {
    assertClaimPayloadName(name);
    if (!Number.isSafeInteger(maxBytes)
      || maxBytes < 1
      || maxBytes > PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES) {
      throw new Error("PrivateStore-Claim-Payload-Limit ist ungültig.");
    }
    const state = this.#claimState(claim);
    const entries = await this.#claimFileIdentities(claim);
    assertPayloadEntrySet(entries, {
      manifest: entries.has("manifest.json") ? "required" : "forbidden",
      payloads: entries.has("manifest.json") ? "complete" : "partial",
    });
    const expectedIdentity = entries.get(name);
    if (!expectedIdentity) {
      throw new Error("PrivateStore-Claim-Payload fehlt.");
    }
    const payloadPath = join(state.directory.path, name);
    let handle: FileHandle | null = null;
    try {
      await this.assertDirectoryClaim(claim);
      handle = await openIdentityHandle(payloadPath, "file");
      if (!handle) throw new Error("PrivateStore-Claim-Payload konnte nicht gebunden werden.");
      await this.assertDirectoryClaim(claim);
      const identity = await assertHandlePathIdentity(handle, payloadPath, "file");
      assertSameIdentity(expectedIdentity, identity, payloadPath);
      await this.assertDirectoryClaim(claim);
      const info = await handle.stat({ bigint: true });
      await this.assertDirectoryClaim(claim);
      if (info.size > BigInt(maxBytes)) {
        throw new Error("PrivateStore-Claim-Payload ist zu groß.");
      }
      const content = await handle.readFile();
      if (content.byteLength > maxBytes) {
        throw new Error("PrivateStore-Claim-Payload ist zu groß.");
      }
      await this.assertDirectoryClaim(claim);
      const current = await assertHandlePathIdentity(handle, payloadPath, "file");
      assertSameIdentity(identity, current, payloadPath);
      return content;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Removes only one exact expected fixed payload after the manifest is gone. */
  async removeClaimPayload(
    claim: PrivateDirectoryClaim,
    name: PrivateStoreClaimPayloadName,
    expectedContent: string,
  ): Promise<void> {
    assertClaimPayloadName(name);
    const expectedBytes = typeof expectedContent === "string"
      ? Buffer.from(expectedContent, "utf8")
      : null;
    if (!expectedBytes
      || expectedBytes.byteLength > PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES) {
      throw new Error("PrivateStore-Claim-Payload-Erwartung ist ungültig.");
    }
    const state = this.#claimState(claim);
    let entries = await this.#claimFileIdentities(claim);
    assertPayloadEntrySet(entries, { manifest: "forbidden", payloads: "partial" });
    const initial = await this.#readClaimPayloadBytes(
      claim,
      name,
      PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES,
    );
    if (!initial.equals(expectedBytes)) {
      throw new Error("PrivateStore-Claim-Payload stimmt nicht exakt überein.");
    }
    const payloadPath = join(state.directory.path, name);
    const expectedIdentity = entries.get(name);
    if (!expectedIdentity) {
      throw new Error("PrivateStore-Claim-Payload fehlt.");
    }
    let handle: FileHandle | null = null;
    try {
      entries = await this.#claimFileIdentities(claim);
      assertPayloadEntrySet(entries, { manifest: "forbidden", payloads: "partial" });
      const currentExpected = entries.get(name);
      if (!currentExpected) throw new Error("PrivateStore-Claim-Payload fehlt.");
      assertSameIdentity(expectedIdentity, currentExpected, payloadPath);
      handle = await openIdentityHandle(payloadPath, "file");
      if (!handle) throw new Error("PrivateStore-Claim-Payload konnte nicht gebunden werden.");
      await this.assertDirectoryClaim(claim);
      const identity = await assertHandlePathIdentity(handle, payloadPath, "file");
      assertSameIdentity(currentExpected, identity, payloadPath);
      await this.assertDirectoryClaim(claim);
      const info = await handle.stat({ bigint: true });
      if (info.size > BigInt(PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES)) {
        throw new Error("PrivateStore-Claim-Payload ist zu groß.");
      }
      const readback = await handle.readFile();
      await this.assertDirectoryClaim(claim);
      const current = await assertHandlePathIdentity(handle, payloadPath, "file");
      assertSameIdentity(identity, current, payloadPath);
      if (!readback.equals(expectedBytes)) {
        throw new Error("PrivateStore-Claim-Payload änderte sich vor der Freigabe.");
      }
      // Node exposes no unlinkat equivalent bound to the directory handle.
      // Revalidate every observable boundary and never fall back to recursion.
      await unlink(payloadPath);
      await this.assertDirectoryClaim(claim);
      await assertMissingPath(payloadPath);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    entries = await this.#claimFileIdentities(claim);
    assertPayloadEntrySet(entries, { manifest: "forbidden", payloads: "partial" });
    if (entries.has(name)) {
      throw new Error("PrivateStore-Claim-Payload wurde nicht entfernt.");
    }
  }

  /**
   * Publishes only the fixed manifest.json inside an exact claimed directory.
   * The claim may otherwise contain either no entries or the complete fixed
   * payload set; updates replace only the previously-bound regular manifest.
   */
  async writeClaimManifest(
    claim: PrivateDirectoryClaim,
    content: string,
    expectedContent: string | null,
  ): Promise<void> {
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 65_536) {
      throw new Error("PrivateStore-Claim-Manifest ist ungültig oder zu groß.");
    }
    if (expectedContent !== null
      && (typeof expectedContent !== "string"
        || Buffer.byteLength(expectedContent, "utf8") > 65_536)) {
      throw new Error("PrivateStore-Claim-Manifest-Erwartung ist ungültig.");
    }
    const state = this.#claimState(claim);
    const manifestPath = join(state.directory.path, "manifest.json");
    const temporaryPath = join(
      state.directory.path,
      `.manifest.${randomUUID()}.private.tmp`,
    );
    const tree = [...state.ancestors, state.directory];
    let previousIdentity: PathIdentity | null = null;
    let temporaryIdentity: PathIdentity | null = null;
    let handle: FileHandle | null = null;
    let published = false;
    try {
      const entries = await this.#claimFileIdentities(claim);
      assertPayloadEntrySet(entries, {
        manifest: expectedContent === null ? "forbidden" : "required",
        payloads: "complete-or-empty",
      });
      previousIdentity = entries.get("manifest.json") ?? null;
      if (previousIdentity) {
        const previousHandle = await openIdentityHandle(manifestPath, "file");
        if (!previousHandle) {
          throw new Error("PrivateStore-Claim-Manifest konnte nicht gebunden werden.");
        }
        try {
          await this.assertDirectoryClaim(claim);
          const opened = await assertHandlePathIdentity(
            previousHandle,
            manifestPath,
            "file",
          );
          assertSameIdentity(previousIdentity, opened, manifestPath);
          await this.assertDirectoryClaim(claim);
          const info = await previousHandle.stat({ bigint: true });
          if (info.size > 65_536n) {
            throw new Error("PrivateStore-Claim-Manifest ist zu groß.");
          }
          const previous = await previousHandle.readFile("utf8");
          await this.assertDirectoryClaim(claim);
          const current = await assertHandlePathIdentity(
            previousHandle,
            manifestPath,
            "file",
          );
          assertSameIdentity(previousIdentity, current, manifestPath);
          if (previous !== expectedContent) {
            throw new Error("PrivateStore-Claim-Manifest stimmt vor dem Update nicht überein.");
          }
        } finally {
          await previousHandle.close().catch(() => undefined);
        }
      }
      handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
      await this.assertDirectoryClaim(claim);
      temporaryIdentity = await assertHandlePathIdentity(handle, temporaryPath, "file");
      await protectOpenPath(
        handle,
        temporaryPath,
        "file",
        this.adapter,
        tree,
        temporaryIdentity,
      );
      await this.assertDirectoryClaim(claim);
      await handle.writeFile(content, "utf8");
      await this.assertDirectoryClaim(claim);
      await handle.sync();
      await this.assertDirectoryClaim(claim);
      temporaryIdentity = await assertHandlePathIdentity(handle, temporaryPath, "file");
      if (previousIdentity) await assertPathIdentity(previousIdentity);
      await this.assertDirectoryClaim(claim);
      await rename(temporaryPath, manifestPath);
      published = true;
      temporaryIdentity = { ...temporaryIdentity, path: manifestPath };
      await this.assertDirectoryClaim(claim);
      await assertPathIdentity(temporaryIdentity);
    } catch (error) {
      if (!published) {
        await unlinkBoundTemporary(temporaryIdentity, tree, handle);
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const readback = await this.readClaimManifest(claim, 65_536);
    if (readback !== content) {
      throw new Error("PrivateStore-Claim-Manifest stimmt nach dem Schreiben nicht überein.");
    }
  }

  /** Reads the sole fixed regular manifest through the exact claim token. */
  async readClaimManifest(
    claim: PrivateDirectoryClaim,
    maxBytes = 65_536,
  ): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536) {
      throw new Error("PrivateStore-Claim-Manifest-Limit ist ungültig.");
    }
    const state = this.#claimState(claim);
    const manifestPath = join(state.directory.path, "manifest.json");
    let handle: FileHandle | null = null;
    try {
      const entries = await this.#claimFileIdentities(claim);
      assertPayloadEntrySet(entries, {
        manifest: "required",
        payloads: "complete-or-empty",
      });
      const expectedIdentity = entries.get("manifest.json");
      if (!expectedIdentity) {
        throw new Error("PrivateStore-Claim enthält kein reguläres Manifest.");
      }
      handle = await openIdentityHandle(manifestPath, "file");
      if (!handle) throw new Error("PrivateStore-Claim-Manifest konnte nicht gebunden werden.");
      await this.assertDirectoryClaim(claim);
      const identity = await assertHandlePathIdentity(handle, manifestPath, "file");
      assertSameIdentity(expectedIdentity, identity, manifestPath);
      await this.assertDirectoryClaim(claim);
      const info = await handle.stat({ bigint: true });
      await this.assertDirectoryClaim(claim);
      if (info.size > BigInt(maxBytes)) {
        throw new Error("PrivateStore-Claim-Manifest ist zu groß.");
      }
      const content = await handle.readFile("utf8");
      await this.assertDirectoryClaim(claim);
      const current = await assertHandlePathIdentity(handle, manifestPath, "file");
      assertSameIdentity(identity, current, manifestPath);
      return content;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Removes the exact manifest, leaving either an empty claim or all payloads. */
  async removeClaimManifest(
    claim: PrivateDirectoryClaim,
    expectedContent: string,
  ): Promise<void> {
    if (typeof expectedContent !== "string"
      || Buffer.byteLength(expectedContent, "utf8") > 65_536) {
      throw new Error("PrivateStore-Claim-Manifest-Erwartung ist ungültig.");
    }
    const state = this.#claimState(claim);
    const manifestPath = join(state.directory.path, "manifest.json");
    const initial = await this.readClaimManifest(claim, 65_536);
    if (initial !== expectedContent) {
      throw new Error("PrivateStore-Claim-Manifest stimmt nicht exakt überein.");
    }
    let handle: FileHandle | null = null;
    try {
      const entries = await this.#claimFileIdentities(claim);
      assertPayloadEntrySet(entries, {
        manifest: "required",
        payloads: "complete-or-empty",
      });
      const expectedIdentity = entries.get("manifest.json");
      if (!expectedIdentity) {
        throw new Error("PrivateStore-Claim enthält kein reguläres Manifest.");
      }
      handle = await openIdentityHandle(manifestPath, "file");
      if (!handle) throw new Error("PrivateStore-Claim-Manifest konnte nicht gebunden werden.");
      await this.assertDirectoryClaim(claim);
      const identity = await assertHandlePathIdentity(handle, manifestPath, "file");
      assertSameIdentity(expectedIdentity, identity, manifestPath);
      await this.assertDirectoryClaim(claim);
      const readback = await handle.readFile("utf8");
      await this.assertDirectoryClaim(claim);
      const current = await assertHandlePathIdentity(handle, manifestPath, "file");
      assertSameIdentity(identity, current, manifestPath);
      if (readback !== expectedContent) {
        throw new Error("PrivateStore-Claim-Manifest änderte sich vor der Freigabe.");
      }
      // Node exposes no unlinkat equivalent bound to the directory handle. A
      // same-user process can race this final checked pathname syscall; every
      // observable boundary is fenced, but this is not a broader security claim.
      await unlink(manifestPath);
      await this.assertDirectoryClaim(claim);
      await assertMissingPath(manifestPath);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const entries = await this.#claimFileIdentities(claim);
    assertPayloadEntrySet(entries, {
      manifest: "forbidden",
      payloads: "complete-or-empty",
    });
  }

  /**
   * Releases only the exact claimed inode. The directory must contain either
   * no entries (ownerless crash claim) or exactly the expected owner.json.
   * There is intentionally no recursive or path-only release fallback.
   */
  async releaseDirectoryClaim(
    claim: PrivateDirectoryClaim,
    expectedOwner: string | null,
  ): Promise<void> {
    const state = this.#claimState(claim);
    await this.assertDirectoryClaim(claim);
    let entries = await readdir(state.directory.path, { withFileTypes: true });
    await this.assertDirectoryClaim(claim);
    if (expectedOwner === null) {
      if (entries.length !== 0) {
        throw new Error("PrivateStore-Claim ist nicht leer und bleibt erhalten.");
      }
    } else {
      if (
        entries.length !== 1
        || entries[0]?.name !== "owner.json"
        || !entries[0].isFile()
        || entries[0].isSymbolicLink()
      ) {
        throw new Error("PrivateStore-Claim enthält unerwartete Inhalte und bleibt erhalten.");
      }
      const ownerPath = join(state.directory.path, "owner.json");
      const actual = await this.readClaimOwner(claim);
      await this.assertDirectoryClaim(claim);
      if (actual !== expectedOwner) {
        throw new Error("PrivateStore-Claim-Owner stimmt nicht exakt überein.");
      }
      const handle = await openIdentityHandle(ownerPath, "file");
      if (!handle) throw new Error("PrivateStore-Claim-Owner konnte nicht gebunden werden.");
      try {
        await this.assertDirectoryClaim(claim);
        const identity = await assertHandlePathIdentity(handle, ownerPath, "file");
        await this.assertDirectoryClaim(claim);
        const readback = await handle.readFile("utf8");
        await this.assertDirectoryClaim(claim);
        const current = await assertHandlePathIdentity(handle, ownerPath, "file");
        assertSameIdentity(identity, current, ownerPath);
        if (readback !== expectedOwner) {
          throw new Error("PrivateStore-Claim-Owner änderte sich vor der Freigabe.");
        }
        // Node exposes no unlinkat/rmdirat equivalent bound to directoryHandle.
        // A same-user process can still race the final checked pathname syscall;
        // every observable boundary is revalidated, but this is not a claim of
        // protection against an equally privileged local attacker.
        await unlink(ownerPath);
        await this.assertDirectoryClaim(claim);
        await assertMissingPath(ownerPath);
      } finally {
        await handle.close().catch(() => undefined);
      }
      entries = await readdir(state.directory.path, { withFileTypes: true });
      await this.assertDirectoryClaim(claim);
      if (entries.length !== 0) {
        throw new Error("PrivateStore-Claim ist nach Owner-Freigabe nicht leer.");
      }
    }
    const directoryHandle = await openIdentityHandle(state.directory.path, "directory");
    try {
      await this.assertDirectoryClaim(claim);
      if (directoryHandle) {
        const current = await assertHandlePathIdentity(
          directoryHandle,
          state.directory.path,
          "directory",
        );
        assertSameIdentity(state.directory, current, state.directory.path);
      }
      // See the unlink note above: Node cannot issue this rmdir relative to the
      // already-bound handle, so the final same-user syscall window remains.
      await rmdir(state.directory.path);
      await assertDirectoryIdentities(state.ancestors);
      await assertMissingPath(state.directory.path);
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }
  }

  async #claimFileIdentities(
    claim: PrivateDirectoryClaim,
  ): Promise<ReadonlyMap<string, PathIdentity>> {
    const state = this.#claimState(claim);
    await this.assertDirectoryClaim(claim);
    const before = await readdir(state.directory.path, { withFileTypes: true });
    await this.assertDirectoryClaim(claim);
    const identities = new Map<string, PathIdentity>();
    for (const entry of [...before].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name !== "manifest.json"
        && !PRIVATE_STORE_CLAIM_PAYLOAD_NAME_SET.has(entry.name)) {
        throw new Error("PrivateStore-Claim enthält unerwartete Einträge.");
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("PrivateStore-Claim enthält kein reguläres Manifest/Payload.");
      }
      const path = join(state.directory.path, entry.name);
      let handle: FileHandle | null = null;
      try {
        await this.assertDirectoryClaim(claim);
        handle = await openIdentityHandle(path, "file");
        if (!handle) {
          throw new Error("PrivateStore-Claim-Datei konnte nicht gebunden werden.");
        }
        await this.assertDirectoryClaim(claim);
        const identity = await assertHandlePathIdentity(handle, path, "file");
        await this.assertDirectoryClaim(claim);
        if (PRIVATE_STORE_CLAIM_PAYLOAD_NAME_SET.has(entry.name)) {
          const info = await handle.stat({ bigint: true });
          if (info.size > BigInt(PRIVATE_STORE_CLAIM_PAYLOAD_MAX_BYTES)) {
            throw new Error("PrivateStore-Claim-Payload ist zu groß.");
          }
        }
        identities.set(entry.name, identity);
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    await this.assertDirectoryClaim(claim);
    const after = await readdir(state.directory.path, { withFileTypes: true });
    await this.assertDirectoryClaim(claim);
    if (before.length !== after.length) {
      throw new Error("PrivateStore-Claim-Inhalte änderten sich während der Prüfung.");
    }
    const afterByName = new Map(after.map((entry) => [entry.name, entry]));
    for (const entry of before) {
      const current = afterByName.get(entry.name);
      if (!current || !current.isFile() || current.isSymbolicLink()) {
        throw new Error("PrivateStore-Claim-Inhalte änderten sich während der Prüfung.");
      }
      const identity = identities.get(entry.name);
      if (!identity) {
        throw new Error("PrivateStore-Claim-Datei wurde nicht gebunden.");
      }
      await assertPathIdentity(identity);
    }
    await this.assertDirectoryClaim(claim);
    return identities;
  }

  #claimToken(
    ancestors: readonly PathIdentity[],
    directory: PathIdentity,
    modifiedAtMs: number,
  ): PrivateDirectoryClaim {
    const state: PrivateDirectoryClaimState = Object.freeze({
      owner: this.#claimOwner,
      ancestors: Object.freeze(ancestors.map((identity) => Object.freeze({ ...identity }))),
      directory: Object.freeze({ ...directory }),
      modifiedAtMs,
    });
    return Object.freeze({ [PRIVATE_DIRECTORY_CLAIM_IDENTITY]: state });
  }

  #claimState(claim: PrivateDirectoryClaim): PrivateDirectoryClaimState {
    const state = claim?.[PRIVATE_DIRECTORY_CLAIM_IDENTITY];
    if (!state || state.owner !== this.#claimOwner) {
      throw new Error("PrivateStore-Claim-Token ist ungültig oder gehört zu einem anderen Store.");
    }
    return state;
  }

  async writeTextAtomic(
    path: string,
    content: string,
    beforePublish?: () => Promise<void>,
  ): Promise<void> {
    await this.assertAvailable();
    const target = resolve(path);
    const parent = dirname(target);
    const root = this.#root ?? parent;
    assertContained(root, target);
    const temporary = `${target}.${randomUUID()}.private.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let createdDirectories: PathIdentity[] = [];
    let ancestors: PathIdentity[] = [];
    let temporaryIdentity: PathIdentity | null = null;
    try {
      createdDirectories = await ensurePrivateDirectoryTree(root, parent, this.adapter);
      ancestors = await directoryIdentities(root, parent);
      handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
      temporaryIdentity = await assertHandlePathIdentity(handle, temporary, "file");
      await protectOpenPath(
        handle,
        temporary,
        "file",
        this.adapter,
        ancestors,
        temporaryIdentity,
      );
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await assertDirectoryIdentities(ancestors);
      temporaryIdentity = await assertHandlePathIdentity(handle, temporary, "file");
      await handle.close();
      handle = null;
      await assertDirectoryIdentities(ancestors);
      await assertPathIdentity(temporaryIdentity);
      await beforePublish?.();
      await assertDirectoryIdentities(ancestors);
      await assertPathIdentity(temporaryIdentity);
      await rename(temporary, target);
      await assertDirectoryIdentities(ancestors);
      await assertPathIdentity({ ...temporaryIdentity, path: target });
    } catch (error) {
      await unlinkBoundTemporary(temporaryIdentity, ancestors, handle);
      await handle?.close().catch(() => undefined);
      await rollbackCreatedDirectories(createdDirectories);
      throw error;
    }
  }

  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async removeTree(path: string): Promise<void> {
    const target = resolve(path);
    const root = this.#root ?? target;
    assertContained(root, target);
    if (target === root) {
      throw new Error(`PrivateStore entfernt seine eigene Root-Grenze nicht: ${target}`);
    }
    let ancestors: PathIdentity[];
    try {
      ancestors = await directoryIdentities(root, dirname(target));
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    await removeBoundTree(target, ancestors);
  }

  async renameTree(
    sourcePath: string,
    destinationPath: string,
    sourceRootPath: string = dirname(sourcePath),
  ): Promise<void> {
    await this.assertAvailable();
    const source = resolve(sourcePath);
    const sourceRoot = resolve(sourceRootPath);
    const destination = resolve(destinationPath);
    const destinationRoot = this.#root ?? dirname(destination);
    assertContained(sourceRoot, source);
    assertContained(destinationRoot, destination);
    const sourceAncestors = await directoryIdentities(sourceRoot, dirname(source));
    const destinationAncestors = await directoryIdentities(destinationRoot, dirname(destination));
    await assertDirectoryIdentities(sourceAncestors);
    await assertDirectoryIdentities(destinationAncestors);
    const sourceInfo = await lstat(source, { bigint: true });
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
      throw new Error(`PrivateStore verschiebt nur ein echtes Quellverzeichnis: ${source}`);
    }
    const sourceHandle = await openIdentityHandle(source, "directory");
    const preOpenSourceIdentity = pathIdentity(source, sourceInfo, "directory");
    let sourceIdentity = preOpenSourceIdentity;
    try {
      if (sourceHandle) {
        sourceIdentity = await assertHandlePathIdentity(sourceHandle, source, "directory");
        assertSameIdentity(preOpenSourceIdentity, sourceIdentity, source);
      } else {
        await assertPathIdentity(sourceIdentity);
      }
      await assertDirectoryIdentities(sourceAncestors);
      await assertDirectoryIdentities(destinationAncestors);
      try {
        await lstat(destination);
        throw new Error(`PrivateStore-Ziel existiert bereits: ${destination}`);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      await assertDirectoryIdentities(sourceAncestors);
      await assertDirectoryIdentities(destinationAncestors);
      if (sourceHandle) {
        const currentSourceIdentity = await assertHandlePathIdentity(
          sourceHandle,
          source,
          "directory",
        );
        assertSameIdentity(sourceIdentity, currentSourceIdentity, source);
      } else {
        await assertPathIdentity(sourceIdentity);
      }
      await rename(source, destination);
      await assertDirectoryIdentities(sourceAncestors);
      await assertDirectoryIdentities(destinationAncestors);
      await assertMissingPath(source);
      await assertPathIdentity({ ...sourceIdentity, path: destination });
    } finally {
      await sourceHandle?.close().catch(() => undefined);
    }
    await assertDirectoryIdentities(sourceAncestors);
    await assertDirectoryIdentities(destinationAncestors);
    await assertMissingPath(source);
    await assertPathIdentity({ ...sourceIdentity, path: destination });
  }

  async protectTree(path: string): Promise<void> {
    await this.assertAvailable();
    const target = resolve(path);
    const root = this.#root ?? target;
    assertContained(root, target);
    const ancestors = await directoryIdentities(root, target === root ? root : dirname(target));
    await this.#protectTree(target, ancestors);
  }

  async #protectTree(
    path: string,
    ancestors: readonly PathIdentity[],
    expectedIdentity?: PathIdentity,
  ): Promise<void> {
    if (!expectedIdentity) await assertDirectoryIdentities(ancestors);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) {
      throw new Error(`PrivateStore schützt keine symbolischen Links in exakten Daten: ${path}`);
    }
    if (expectedIdentity) {
      const actualKind = info.isDirectory() ? "directory" : info.isFile() ? "file" : null;
      if (!actualKind) throw new Error(`PrivateStore schützt nur reguläre Dateien: ${path}`);
      assertSameIdentity(expectedIdentity, pathIdentity(path, info, actualKind), path);
      await assertDirectoryIdentities(ancestors);
    }
    if (!info.isDirectory()) {
      if (!info.isFile()) throw new Error(`PrivateStore schützt nur reguläre Dateien: ${path}`);
      await protectBoundPath(
        path,
        "file",
        this.adapter,
        ancestors,
        expectedIdentity ?? pathIdentity(path, info, "file"),
      );
      return;
    }
    const identity = await protectBoundPath(
      path,
      "directory",
      this.adapter,
      ancestors,
      expectedIdentity ?? pathIdentity(path, info, "directory"),
    );
    const tree = [...ancestors, identity];
    await assertDirectoryIdentities(tree);
    const entries = await readdir(path, { withFileTypes: true });
    await assertDirectoryIdentities(tree);
    for (const entry of entries) {
      await assertDirectoryIdentities(tree);
      const child = join(path, entry.name);
      const childInfo = await lstat(child);
      await assertDirectoryIdentities(tree);
      if (childInfo.isSymbolicLink()) {
        throw new Error(`PrivateStore schützt keine symbolischen Links in exakten Daten: ${child}`);
      }
      if (childInfo.isDirectory()) {
        await this.#protectTree(
          child,
          tree,
          pathIdentity(child, childInfo, "directory"),
        );
      } else if (childInfo.isFile()) {
        await protectBoundPath(
          child,
          "file",
          this.adapter,
          tree,
          pathIdentity(child, childInfo, "file"),
        );
      }
    }
    await assertDirectoryIdentities(tree);
  }
}

/**
 * Establishes the configured boundary required by an exclusive claim. Unlike
 * the generic exact-store directory helper, this permanent root is never
 * path-rolled back: a failed protection or identity check leaves the empty
 * object untouched for fail-closed inspection.
 */
async function ensureExclusiveClaimRoot(
  rootPath: string,
  adapter: PrivateStoreAdapter,
): Promise<PathIdentity> {
  const root = resolve(rootPath);
  let info;
  try {
    info = await lstat(root, { bigint: true });
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    try {
      await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (mkdirError) {
      if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
    }
    info = await lstat(root, { bigint: true });
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`PrivateStore-Claim-Root ist kein echtes Verzeichnis: ${root}`);
  }
  const identity = pathIdentity(root, info, "directory");
  const protectedIdentity = await protectBoundPath(
    root,
    "directory",
    adapter,
    [],
    identity,
  );
  assertSameIdentity(identity, protectedIdentity, root);
  await assertPathIdentity(protectedIdentity);
  return protectedIdentity;
}

async function ensurePrivateDirectoryTree(
  rootPath: string,
  targetPath: string,
  adapter: PrivateStoreAdapter,
): Promise<PathIdentity[]> {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  assertContained(root, target);
  const created: PathIdentity[] = [];
  const verified: PathIdentity[] = [];
  try {
    verified.push(await ensureOneDirectory(root, adapter, created, verified));
    const suffix = relative(root, target);
    let current = root;
    for (const component of suffix ? suffix.split(sep) : []) {
      current = join(current, component);
      await assertDirectoryIdentities(verified);
      verified.push(await ensureOneDirectory(current, adapter, created, verified));
    }
    return created;
  } catch (error) {
    await rollbackCreatedDirectories(created);
    throw error;
  }
}

async function ensureOneDirectory(
  path: string,
  adapter: PrivateStoreAdapter,
  created: PathIdentity[],
  ancestors: readonly PathIdentity[],
): Promise<PathIdentity> {
  let identity: PathIdentity;
  try {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`PrivateStore-Verzeichnis ist kein echtes Verzeichnis: ${path}`);
    }
    identity = pathIdentity(path, info, "directory");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    await assertDirectoryIdentities(ancestors);
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    await assertDirectoryIdentities(ancestors);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`PrivateStore-Verzeichnis wurde bei der Erstellung ausgetauscht: ${path}`);
    }
    identity = pathIdentity(path, info, "directory");
    created.push(identity);
  }
  await assertDirectoryIdentities(ancestors);
  const protectedIdentity = await protectBoundPath(
    path,
    "directory",
    adapter,
    ancestors,
    identity,
  );
  if (!sameIdentity(identity, protectedIdentity)) {
    throw new Error(`PrivateStore-Verzeichnis wurde während der Absicherung ausgetauscht: ${path}`);
  }
  return protectedIdentity;
}

async function rollbackCreatedDirectories(paths: readonly PathIdentity[]): Promise<void> {
  for (const identity of [...paths].reverse()) {
    try {
      const info = await lstat(identity.path, { bigint: true });
      if (!info.isSymbolicLink() && info.isDirectory()
        && info.dev === identity.dev && info.ino === identity.ino) {
        await rmdir(identity.path);
      }
    } catch {
      // Best effort only: never follow or recursively remove a path that changed identity.
    }
  }
}

async function directoryIdentities(rootPath: string, targetPath: string): Promise<PathIdentity[]> {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  assertContained(root, target);
  const paths = [root];
  const suffix = relative(root, target);
  let current = root;
  for (const component of suffix ? suffix.split(sep) : []) {
    current = join(current, component);
    paths.push(current);
  }
  const identities: PathIdentity[] = [];
  for (const path of paths) {
    await assertDirectoryIdentities(identities);
    const info = await lstat(path, { bigint: true });
    await assertDirectoryIdentities(identities);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Symbolischer Link oder ungültiger PrivateStore-Pfad: ${path}`);
    }
    identities.push(pathIdentity(path, info, "directory"));
  }
  return identities;
}

async function assertDirectoryIdentities(expected: readonly PathIdentity[]): Promise<void> {
  const current = await Promise.all(expected.map(async (identity) => ({
    identity,
    info: await lstat(identity.path, { bigint: true }),
  })));
  for (const { identity, info } of current) {
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino) {
      throw new Error(`PrivateStore-Pfad wurde vor dem Publish ausgetauscht: ${identity.path}`);
    }
  }
}

function assertClaimPayloadName(
  name: unknown,
): asserts name is PrivateStoreClaimPayloadName {
  if (typeof name !== "string" || !PRIVATE_STORE_CLAIM_PAYLOAD_NAME_SET.has(name)) {
    throw new Error("PrivateStore-Claim-Payload-Name ist nicht in der Allowlist.");
  }
}

function decodeCanonicalClaimPayloadUtf8(bytes: Buffer): string {
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    throw new Error("PrivateStore-Claim-Payload ist kein kanonisches UTF-8.");
  }
  return content;
}

function assertPayloadEntrySet(
  entries: ReadonlyMap<string, PathIdentity>,
  expected: {
    readonly manifest: "required" | "forbidden";
    readonly payloads: "partial" | "complete" | "complete-or-empty";
  },
): void {
  const hasManifest = entries.has("manifest.json");
  if ((expected.manifest === "required") !== hasManifest) {
    throw new Error("PrivateStore-Claim-Manifest/Payload-Satz ist unvollständig.");
  }
  const payloadCount = PRIVATE_STORE_CLAIM_PAYLOAD_AUTHORITY.reduce(
    (count, name) => count + Number(entries.has(name)),
    0,
  );
  const complete = payloadCount === PRIVATE_STORE_CLAIM_PAYLOAD_AUTHORITY.length;
  if ((expected.payloads === "complete" && !complete)
    || (expected.payloads === "complete-or-empty" && payloadCount !== 0 && !complete)) {
    throw new Error("PrivateStore-Claim-Payload-Satz ist unvollständig.");
  }
}

async function assertHandlePathIdentity(
  handle: FileHandle,
  path: string,
  kind: "directory" | "file",
): Promise<PathIdentity> {
  const [opened, named] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  const validKind = kind === "directory"
    ? opened.isDirectory() && named.isDirectory()
    : opened.isFile() && named.isFile();
  if (named.isSymbolicLink() || !validKind || opened.dev !== named.dev || opened.ino !== named.ino) {
    throw new Error(`PrivateStore-Pfad wurde vor dem Publish ausgetauscht: ${path}`);
  }
  return pathIdentity(path, named, kind);
}

async function assertPathIdentity(expected: PathIdentity): Promise<void> {
  const info = await lstat(expected.path, { bigint: true });
  const validKind = expected.kind === "directory" ? info.isDirectory() : info.isFile();
  if (info.isSymbolicLink() || !validKind || info.dev !== expected.dev || info.ino !== expected.ino) {
    throw new Error(`PrivateStore-Pfad wurde ausgetauscht: ${expected.path}`);
  }
}

async function protectBoundPath(
  path: string,
  kind: "directory" | "file",
  adapter: PrivateStoreAdapter,
  ancestors: readonly PathIdentity[],
  expectedIdentity: PathIdentity,
): Promise<PathIdentity> {
  await assertDirectoryIdentities(ancestors);
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink()
    || (kind === "directory" ? !before.isDirectory() : !before.isFile())) {
    throw new Error(`PrivateStore-${kind === "directory" ? "Verzeichnis" : "Datei"} ist ungültig: ${path}`);
  }
  const preOpenIdentity = pathIdentity(path, before, kind);
  assertSameIdentity(expectedIdentity, preOpenIdentity, path);
  const handle = await openIdentityHandle(path, kind);
  if (!handle) {
    await assertDirectoryIdentities(ancestors);
    await (kind === "directory"
      ? adapter.protectDirectory(path, undefined, preOpenIdentity)
      : adapter.protectFile(path, undefined, preOpenIdentity));
    await assertDirectoryIdentities(ancestors);
    await assertPathIdentity(preOpenIdentity);
    return preOpenIdentity;
  }
  let protectedIdentity: PathIdentity;
  try {
    protectedIdentity = await protectOpenPath(
      handle,
      path,
      kind,
      adapter,
      ancestors,
      preOpenIdentity,
    );
  } finally {
    await handle.close();
  }
  await assertDirectoryIdentities(ancestors);
  await assertPathIdentity(protectedIdentity);
  return protectedIdentity;
}

async function protectOpenPath(
  handle: FileHandle,
  path: string,
  kind: "directory" | "file",
  adapter: PrivateStoreAdapter,
  ancestors: readonly PathIdentity[],
  preOpenIdentity?: PathIdentity,
): Promise<PathIdentity> {
  await assertDirectoryIdentities(ancestors);
  const identity = await assertHandlePathIdentity(handle, path, kind);
  if (preOpenIdentity) assertSameIdentity(preOpenIdentity, identity, path);
  await assertDirectoryIdentities(ancestors);
  await (kind === "directory"
    ? adapter.protectDirectory(path, handle, identity)
    : adapter.protectFile(path, handle, identity));
  await assertDirectoryIdentities(ancestors);
  const protectedIdentity = await assertHandlePathIdentity(handle, path, kind);
  if (!sameIdentity(identity, protectedIdentity)) {
    throw new Error(`PrivateStore-Pfad wurde während der Absicherung ausgetauscht: ${path}`);
  }
  return protectedIdentity;
}

async function removeBoundTree(
  path: string,
  ancestors: readonly PathIdentity[],
): Promise<void> {
  await assertDirectoryIdentities(ancestors);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  await assertDirectoryIdentities(ancestors);
  if (info.isSymbolicLink()) {
    throw new Error(`PrivateStore entfernt keinen symbolischen Link: ${path}`);
  }
  if (info.isFile()) {
    const preOpenIdentity = pathIdentity(path, info, "file");
    const handle = await openIdentityHandle(path, "file");
    try {
      const identity = handle
        ? await assertHandlePathIdentity(handle, path, "file")
        : preOpenIdentity;
      assertSameIdentity(preOpenIdentity, identity, path);
      await assertDirectoryIdentities(ancestors);
      if (handle) await assertHandlePathIdentity(handle, path, "file");
      else await assertPathIdentity(identity);
      await unlink(path);
      await assertDirectoryIdentities(ancestors);
      await assertMissingPath(path);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    await assertDirectoryIdentities(ancestors);
    await assertMissingPath(path);
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(`PrivateStore entfernt nur reguläre Dateien und Verzeichnisse: ${path}`);
  }
  const preOpenIdentity = pathIdentity(path, info, "directory");
  const handle = await openIdentityHandle(path, "directory");
  try {
    const identity = handle
      ? await assertHandlePathIdentity(handle, path, "directory")
      : preOpenIdentity;
    assertSameIdentity(preOpenIdentity, identity, path);
    const tree = [...ancestors, identity];
    await assertDirectoryIdentities(tree);
    const entries = await readdir(path, { withFileTypes: true });
    await assertDirectoryIdentities(tree);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await assertDirectoryIdentities(tree);
      await removeBoundTree(join(path, entry.name), tree);
    }
    await assertDirectoryIdentities(tree);
    await rmdir(path);
    await assertDirectoryIdentities(ancestors);
    await assertMissingPath(path);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await assertDirectoryIdentities(ancestors);
  await assertMissingPath(path);
}

async function assertMissingPath(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(`PrivateStore-Pfad sollte nicht mehr existieren: ${path}`);
}

async function unlinkBoundTemporary(
  identity: PathIdentity | null,
  ancestors: readonly PathIdentity[],
  handle: FileHandle | null,
): Promise<void> {
  if (!identity) return;
  try {
    await assertDirectoryIdentities(ancestors);
    await assertDirectoryIdentities(ancestors);
    if (handle) {
      const current = await assertHandlePathIdentity(handle, identity.path, "file");
      assertSameIdentity(identity, current, identity.path);
    } else {
      await assertPathIdentity(identity);
    }
    await unlink(identity.path);
  } catch {
    // The current name is unknown after an identity mismatch; never unlink it.
  }
}

async function openIdentityHandle(
  path: string,
  kind: "directory" | "file",
): Promise<FileHandle | null> {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const directory = kind === "directory" ? fsConstants.O_DIRECTORY : 0;
  return open(path, fsConstants.O_RDONLY | noFollow | directory);
}

function pathIdentity(
  path: string,
  info: { dev: number | bigint; ino: number | bigint },
  kind: "directory" | "file",
): PathIdentity {
  return { path, dev: BigInt(info.dev), ino: BigInt(info.ino), kind };
}

async function protectionIdentity(
  path: string,
  kind: "directory" | "file",
): Promise<PrivateStoreProtectionIdentity> {
  const info = await lstat(path, { bigint: true });
  const validKind = kind === "directory" ? info.isDirectory() : info.isFile();
  if (info.isSymbolicLink() || !validKind) {
    throw new Error(`PrivateStore-DACL verweigert einen ungültigen Pfad: ${path}`);
  }
  return { dev: info.dev, ino: info.ino, kind };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

function assertSameIdentity(expected: PathIdentity, actual: PathIdentity, path: string): void {
  if (!sameIdentity(expected, actual)) {
    throw new Error(`PrivateStore-Pfad wurde zwischen Prüfung und Öffnen ausgetauscht: ${path}`);
  }
}

function assertContained(rootPath: string, candidatePath: string): void {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const value = relative(root, candidate);
  if (value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error(`PrivateStore-Ziel liegt außerhalb seiner Root-Grenze: ${candidate}`);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

async function runPrivateStoreProcess(
  executable: string,
  args: readonly string[],
  options: PrivateStoreProcessOptions = {},
): Promise<PrivateStoreProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...options.environment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
