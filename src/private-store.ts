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

/**
 * Fail-closed boundary for exact recovery data. Content reaches a file only
 * after the directory and empty exclusive temp file have private permissions.
 */
export class PrivateStore {
  readonly adapter: PrivateStoreAdapter;
  readonly #root: string | null;
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
   * changes fail closed. The caller releases a winning reservation with
   * removeTree(), which repeats the same root-bound identity checks.
   */
  async createDirectoryExclusive(path: string): Promise<boolean> {
    await this.assertAvailable();
    const target = resolve(path);
    const root = this.#root ?? dirname(target);
    assertContained(root, target);
    if (target === root) {
      throw new Error(`PrivateStore reserviert seine eigene Root-Grenze nicht: ${target}`);
    }
    const ancestors = await directoryIdentities(root, dirname(target));
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
      return false;
    }

    let created: PathIdentity | null = null;
    try {
      await assertDirectoryIdentities(ancestors);
      const info = await lstat(target, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`PrivateStore-Lease wurde bei der Erstellung ausgetauscht: ${target}`);
      }
      created = pathIdentity(target, info, "directory");
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
      return true;
    } catch (error) {
      if (created) await rollbackCreatedDirectories([created]);
      throw error;
    }
  }

  async writeTextAtomic(path: string, content: string): Promise<void> {
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
