import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export interface PrivateStoreAdapter {
  readonly name: string;
  available(): Promise<boolean>;
  protectDirectory(path: string): Promise<void>;
  protectFile(path: string): Promise<void>;
}

export class PosixPrivateStoreAdapter implements PrivateStoreAdapter {
  readonly name = "posix-0700-0600";

  async available(): Promise<boolean> {
    return true;
  }

  async protectDirectory(path: string): Promise<void> {
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  }

  async protectFile(path: string): Promise<void> {
    await chmod(path, PRIVATE_FILE_MODE);
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
    const result = await this.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$null = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; exit 0",
    ]).catch(() => null);
    return result?.code === 0;
  }

  async protectDirectory(path: string): Promise<void> {
    await this.protect(path, "directory");
  }

  async protectFile(path: string): Promise<void> {
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

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
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
    await ensurePrivateDirectoryTree(root, parent, this.adapter);
    const ancestors = await directoryIdentities(root, parent);
    const temporary = `${target}.${randomUUID()}.private.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
      await this.adapter.protectFile(temporary);
      await assertDirectoryIdentities(ancestors);
      await assertHandlePathIdentity(handle, temporary);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await assertDirectoryIdentities(ancestors);
      await assertHandlePathIdentity(handle, temporary);
      await handle.close();
      handle = null;
      await rename(temporary, target);
      if (this.adapter instanceof PosixPrivateStoreAdapter) {
        await this.adapter.protectFile(target);
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  async protectTree(path: string): Promise<void> {
    await this.assertAvailable();
    const target = resolve(path);
    const root = this.#root ?? target;
    assertContained(root, target);
    await directoryIdentities(root, target === root ? root : dirname(target));
    await this.#protectTree(target);
  }

  async #protectTree(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`PrivateStore schützt keine symbolischen Links in exakten Daten: ${path}`);
    }
    if (!info.isDirectory()) {
      await this.adapter.protectFile(path);
      return;
    }
    await this.adapter.protectDirectory(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`PrivateStore schützt keine symbolischen Links in exakten Daten: ${child}`);
      }
      if (entry.isDirectory()) {
        await this.#protectTree(child);
      } else if (entry.isFile()) {
        await this.adapter.protectFile(child);
      }
    }
  }
}

async function ensurePrivateDirectoryTree(
  rootPath: string,
  targetPath: string,
  adapter: PrivateStoreAdapter,
): Promise<void> {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  assertContained(root, target);
  await ensureOneDirectory(root, adapter);
  const suffix = relative(root, target);
  let current = root;
  for (const component of suffix ? suffix.split(sep) : []) {
    current = join(current, component);
    await ensureOneDirectory(current, adapter);
  }
}

async function ensureOneDirectory(path: string, adapter: PrivateStoreAdapter): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`PrivateStore-Verzeichnis ist kein echtes Verzeichnis: ${path}`);
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  }
  await adapter.protectDirectory(path);
  const protectedInfo = await lstat(path);
  if (protectedInfo.isSymbolicLink() || !protectedInfo.isDirectory()) {
    throw new Error(`PrivateStore-Verzeichnis wurde während der Absicherung ausgetauscht: ${path}`);
  }
}

async function directoryIdentities(rootPath: string, targetPath: string): Promise<DirectoryIdentity[]> {
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
  const identities: DirectoryIdentity[] = [];
  for (const path of paths) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Symbolischer Link oder ungültiger PrivateStore-Pfad: ${path}`);
    }
    identities.push({ path, dev: info.dev, ino: info.ino });
  }
  return identities;
}

async function assertDirectoryIdentities(expected: readonly DirectoryIdentity[]): Promise<void> {
  for (const identity of expected) {
    const info = await lstat(identity.path);
    if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== identity.dev || info.ino !== identity.ino) {
      throw new Error(`PrivateStore-Pfad wurde vor dem Publish ausgetauscht: ${identity.path}`);
    }
  }
}

async function assertHandlePathIdentity(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
): Promise<void> {
  const [opened, named] = await Promise.all([handle.stat(), lstat(path)]);
  if (named.isSymbolicLink() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
    throw new Error(`PrivateStore-Tempdatei wurde vor dem Publish ausgetauscht: ${path}`);
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
