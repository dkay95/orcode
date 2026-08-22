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

export interface PrivateStoreAdapter {
  readonly name: string;
  available(): Promise<boolean>;
  protectDirectory(path: string, handle?: FileHandle): Promise<void>;
  protectFile(path: string, handle?: FileHandle): Promise<void>;
}

export class PosixPrivateStoreAdapter implements PrivateStoreAdapter {
  readonly name = "posix-0700-0600";

  async available(): Promise<boolean> {
    return true;
  }

  async protectDirectory(path: string, handle?: FileHandle): Promise<void> {
    if (handle) await handle.chmod(PRIVATE_DIRECTORY_MODE);
    else await chmod(path, PRIVATE_DIRECTORY_MODE);
  }

  async protectFile(path: string, handle?: FileHandle): Promise<void> {
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
if ([string]::IsNullOrEmpty($path) -or ($kind -ne 'directory' -and $kind -ne 'file')) { exit 16 }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
if ($kind -eq 'directory') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetAccessRuleProtection($true, $false)
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, $rights, $inheritance, $propagation, $allow)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, $rights, $inheritance, $propagation, $allow)))
Set-Acl -LiteralPath $path -AclObject $acl
$verified = Get-Acl -LiteralPath $path
$expected = @($user.Value, 'S-1-5-18') | Sort-Object -Unique
$actual = @($verified.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) | Sort-Object -Unique
$deny = @($verified.Access | Where-Object { $_.AccessControlType -ne $allow }).Count
if (-not $verified.AreAccessRulesProtected -or $deny -ne 0 -or (Compare-Object $expected $actual)) { exit 17 }
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

  async protectDirectory(path: string, _handle?: FileHandle): Promise<void> {
    await this.protect(path, "directory");
  }

  async protectFile(path: string, _handle?: FileHandle): Promise<void> {
    await this.protect(path, "file");
  }

  private async protect(path: string, kind: "directory" | "file"): Promise<void> {
    const result = await this.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_DACL_ENCODED,
    ], {
      environment: {
        ORCODE_PRIVATE_PATH: path,
        ORCODE_PRIVATE_KIND: kind,
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

interface PathIdentity {
  path: string;
  dev: number;
  ino: number;
  kind: "directory" | "file";
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

  async writeTextAtomic(path: string, content: string): Promise<void> {
    await this.assertAvailable();
    const target = resolve(path);
    const parent = dirname(target);
    const root = this.#root ?? parent;
    assertContained(root, target);
    const temporary = `${target}.${randomUUID()}.private.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let createdDirectories: PathIdentity[] = [];
    try {
      createdDirectories = await ensurePrivateDirectoryTree(root, parent, this.adapter);
      const ancestors = await directoryIdentities(root, parent);
      handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
      await protectOpenPath(handle, temporary, "file", this.adapter, ancestors);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await assertDirectoryIdentities(ancestors);
      const temporaryIdentity = await assertHandlePathIdentity(handle, temporary, "file");
      await handle.close();
      handle = null;
      await assertDirectoryIdentities(ancestors);
      await assertPathIdentity(temporaryIdentity);
      await rename(temporary, target);
      await assertDirectoryIdentities(ancestors);
      await assertPathIdentity({ ...temporaryIdentity, path: target });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
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
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
      throw new Error(`PrivateStore verschiebt nur ein echtes Quellverzeichnis: ${source}`);
    }
    const sourceHandle = await openIdentityHandle(source, "directory");
    let sourceIdentity = pathIdentity(source, sourceInfo, "directory");
    try {
      if (sourceHandle) {
        sourceIdentity = await assertHandlePathIdentity(sourceHandle, source, "directory");
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

  async #protectTree(path: string, ancestors: readonly PathIdentity[]): Promise<void> {
    await assertDirectoryIdentities(ancestors);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`PrivateStore schützt keine symbolischen Links in exakten Daten: ${path}`);
    }
    if (!info.isDirectory()) {
      if (!info.isFile()) throw new Error(`PrivateStore schützt nur reguläre Dateien: ${path}`);
      await protectBoundPath(path, "file", this.adapter, ancestors);
      return;
    }
    const identity = await protectBoundPath(path, "directory", this.adapter, ancestors);
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
        await this.#protectTree(child, tree);
      } else if (childInfo.isFile()) {
        await protectBoundPath(child, "file", this.adapter, tree);
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
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`PrivateStore-Verzeichnis ist kein echtes Verzeichnis: ${path}`);
    }
    identity = pathIdentity(path, info, "directory");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    await assertDirectoryIdentities(ancestors);
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    await assertDirectoryIdentities(ancestors);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`PrivateStore-Verzeichnis wurde bei der Erstellung ausgetauscht: ${path}`);
    }
    identity = pathIdentity(path, info, "directory");
    created.push(identity);
  }
  await assertDirectoryIdentities(ancestors);
  const protectedIdentity = await protectBoundPath(path, "directory", adapter, ancestors);
  if (!sameIdentity(identity, protectedIdentity)) {
    throw new Error(`PrivateStore-Verzeichnis wurde während der Absicherung ausgetauscht: ${path}`);
  }
  return protectedIdentity;
}

async function rollbackCreatedDirectories(paths: readonly PathIdentity[]): Promise<void> {
  for (const identity of [...paths].reverse()) {
    try {
      const info = await lstat(identity.path);
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
    const info = await lstat(path);
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
    info: await lstat(identity.path),
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
  const [opened, named] = await Promise.all([handle.stat(), lstat(path)]);
  const validKind = kind === "directory"
    ? opened.isDirectory() && named.isDirectory()
    : opened.isFile() && named.isFile();
  if (named.isSymbolicLink() || !validKind || opened.dev !== named.dev || opened.ino !== named.ino) {
    throw new Error(`PrivateStore-Pfad wurde vor dem Publish ausgetauscht: ${path}`);
  }
  return pathIdentity(path, named, kind);
}

async function assertPathIdentity(expected: PathIdentity): Promise<void> {
  const info = await lstat(expected.path);
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
): Promise<PathIdentity> {
  await assertDirectoryIdentities(ancestors);
  const before = await lstat(path);
  if (before.isSymbolicLink()
    || (kind === "directory" ? !before.isDirectory() : !before.isFile())) {
    throw new Error(`PrivateStore-${kind === "directory" ? "Verzeichnis" : "Datei"} ist ungültig: ${path}`);
  }
  const handle = await openIdentityHandle(path, kind);
  if (!handle) {
    const identity = pathIdentity(path, before, kind);
    await assertDirectoryIdentities(ancestors);
    await (kind === "directory"
      ? adapter.protectDirectory(path)
      : adapter.protectFile(path));
    await assertDirectoryIdentities(ancestors);
    await assertPathIdentity(identity);
    return identity;
  }
  let protectedIdentity: PathIdentity;
  try {
    protectedIdentity = await protectOpenPath(handle, path, kind, adapter, ancestors);
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
): Promise<PathIdentity> {
  await assertDirectoryIdentities(ancestors);
  const identity = await assertHandlePathIdentity(handle, path, kind);
  await assertDirectoryIdentities(ancestors);
  await (kind === "directory"
    ? adapter.protectDirectory(path, handle)
    : adapter.protectFile(path, handle));
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
    info = await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  await assertDirectoryIdentities(ancestors);
  if (info.isSymbolicLink()) {
    throw new Error(`PrivateStore entfernt keinen symbolischen Link: ${path}`);
  }
  if (info.isFile()) {
    const handle = await openIdentityHandle(path, "file");
    const identity = handle
      ? await assertHandlePathIdentity(handle, path, "file")
      : pathIdentity(path, info, "file");
    try {
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
  const handle = await openIdentityHandle(path, "directory");
  const identity = handle
    ? await assertHandlePathIdentity(handle, path, "directory")
    : pathIdentity(path, info, "directory");
  const tree = [...ancestors, identity];
  try {
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

async function openIdentityHandle(
  path: string,
  kind: "directory" | "file",
): Promise<FileHandle | null> {
  if (process.platform === "win32" && kind === "directory") return null;
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const directory = kind === "directory" ? fsConstants.O_DIRECTORY : 0;
  return open(path, fsConstants.O_RDONLY | noFollow | directory);
}

function pathIdentity(
  path: string,
  info: { dev: number; ino: number },
  kind: "directory" | "file",
): PathIdentity {
  return { path, dev: info.dev, ino: info.ino, kind };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
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
