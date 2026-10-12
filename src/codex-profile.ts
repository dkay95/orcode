import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  statfs,
  type FileHandle,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const CODEX_HOME_ID_PATTERN = /^codex-[0-9a-f]{32}$/;
const CODEX_CONFIG = 'cli_auth_credentials_store = "file"\n';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface LocalFileSystemProbe {
  readonly platform: NodeJS.Platform;
  readonly statFsType: (path: string) => Promise<bigint>;
  readonly inspectDarwinMount: (
    path: string,
  ) => Promise<{ readonly fileSystemType: string; readonly local: boolean } | null>;
}

export interface OwnedDirectoryFileSystem {
  readonly lstat: (path: string) => Promise<BigIntStats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly openDirectory: (path: string) => Promise<Pick<FileHandle, "stat" | "close">>;
}

interface OwnedDirectoryBinding {
  readonly lexical: string;
  readonly canonical: string;
  readonly metadata: BigIntStats;
  readonly handle: Pick<FileHandle, "stat" | "close">;
}

export interface ProfileTreeFileSystem
  extends Pick<OwnedDirectoryFileSystem, "lstat" | "openDirectory"> {
  readonly readdir: (path: string) => Promise<string[]>;
}

declare const codexHomeIdBrand: unique symbol;
export type CodexHomeId = string & { readonly [codexHomeIdBrand]: true };

export interface CodexHomeBindingV1 {
  readonly version: 1;
  readonly homeId: CodexHomeId;
  readonly accountLabel: string;
  readonly credentialStore: "file";
}

export interface CodexProfileRuntime {
  readonly binding: CodexHomeBindingV1;
  readonly codexHome: string;
}

export function parseCodexHomeId(value: string): CodexHomeId {
  if (!CODEX_HOME_ID_PATTERN.test(value)) {
    throw new Error("Codex home ID must use the canonical codex-<128-bit lowercase hex> form.");
  }
  return value as CodexHomeId;
}

export function generateCodexHomeId(): CodexHomeId {
  return parseCodexHomeId(`codex-${randomBytes(16).toString("hex")}`);
}

export async function createCodexHome(options: {
  readonly appHome: string;
  readonly homeId?: CodexHomeId;
  readonly accountLabel: string;
}): Promise<CodexProfileRuntime> {
  const accountLabel = options.accountLabel.trim();
  if (accountLabel.length === 0) throw new Error("Codex account label must not be empty.");

  const appHome = await requireOwnedLocalDirectory(options.appHome, "Orcode app home");
  await rejectGlobalHomeAlias(appHome);
  const homeId = options.homeId === undefined
    ? generateCodexHomeId()
    : parseCodexHomeId(options.homeId);
  const providersDirectory = join(appHome, "providers");
  const codexDirectory = join(providersDirectory, "codex");
  const codexHome = join(codexDirectory, homeId);
  assertDirectChild(appHome, codexHome);
  await rejectGlobalHomeAlias(codexHome);

  await ensureOwnedDirectory(providersDirectory);
  await ensureOwnedDirectory(codexDirectory);
  await ensureOwnedDirectory(codexHome);
  await writeExactConfig(join(codexHome, "config.toml"));
  await assertCodexHomePolicy(codexHome);

  return Object.freeze({
    binding: Object.freeze({
      version: 1,
      homeId,
      accountLabel,
      credentialStore: "file",
    }),
    codexHome,
  });
}

/** Revalidates the profile boundary immediately before launch and after shutdown. */
export async function assertCodexHomePolicy(
  codexHome: string,
  fileSystem: OwnedDirectoryFileSystem = SYSTEM_OWNED_DIRECTORY_FILE_SYSTEM,
): Promise<void> {
  const chain = codexHomeDirectoryChain(codexHome);
  await rejectGlobalHomeAlias(chain.home);
  const bindings: OwnedDirectoryBinding[] = [];
  try {
    for (const [path, label] of [
      [chain.appHome, "Orcode app home"],
      [chain.providers, "Codex providers directory"],
      [chain.codex, "Codex provider directory"],
      [chain.home, "Codex profile home"],
    ] as const) {
      bindings.push(await bindOwnedLocalDirectory(path, label, fileSystem));
    }

    const [appHome, providers, codex, home] = bindings as [
      OwnedDirectoryBinding,
      OwnedDirectoryBinding,
      OwnedDirectoryBinding,
      OwnedDirectoryBinding,
    ];
    requireExactCodexHomeChain(appHome, providers, codex, home, chain.homeId);
    await assertOwnerOnlyProfileTree(home.canonical);
    await assertExactCodexConfig(join(home.canonical, "config.toml"));
    for (const binding of bindings) {
      await revalidateOwnedDirectoryBinding(binding, fileSystem);
    }
  } finally {
    await Promise.all(bindings.map((binding) => binding.handle.close()));
  }
}

async function ensureOwnedDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await requireOwnedLocalDirectory(path, "Codex profile directory");
}

export async function requireOwnedLocalDirectory(
  path: string,
  label: string,
  fileSystem: OwnedDirectoryFileSystem = SYSTEM_OWNED_DIRECTORY_FILE_SYSTEM,
): Promise<string> {
  const binding = await bindOwnedLocalDirectory(path, label, fileSystem);
  try {
    return binding.canonical;
  } finally {
    await binding.handle.close();
  }
}

async function bindOwnedLocalDirectory(
  path: string,
  label: string,
  fileSystem: OwnedDirectoryFileSystem = SYSTEM_OWNED_DIRECTORY_FILE_SYSTEM,
): Promise<OwnedDirectoryBinding> {
  const lexical = resolve(path);
  const lexicalState = await fileSystem.lstat(lexical);
  if (!lexicalState.isDirectory() || lexicalState.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink.`);
  }
  requireCurrentOwner(lexicalState.uid, label);
  if ((Number(lexicalState.mode) & 0o777) !== DIRECTORY_MODE) {
    throw new Error(`${label} permissions must be owner-only 0700.`);
  }
  const handle = await fileSystem.openDirectory(lexical);
  try {
    const opened = await handle.stat({ bigint: true });
    requireSameDirectoryIdentity(lexicalState, opened);
    await requireDirectoryPathIdentity(lexical, opened, fileSystem);
    const canonical = await fileSystem.realpath(lexical);
    await requireDirectoryPathIdentity(canonical, opened, fileSystem);
    await requireDirectoryPathIdentity(lexical, opened, fileSystem);
    await assertLocalFileSystem(canonical, label);
    await requireDirectoryPathIdentity(canonical, opened, fileSystem);
    await requireDirectoryPathIdentity(lexical, opened, fileSystem);
    return { lexical, canonical, metadata: opened, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function revalidateOwnedDirectoryBinding(
  binding: OwnedDirectoryBinding,
  fileSystem: OwnedDirectoryFileSystem = SYSTEM_OWNED_DIRECTORY_FILE_SYSTEM,
): Promise<void> {
  const opened = await binding.handle.stat({ bigint: true });
  requireSameDirectoryIdentity(binding.metadata, opened);
  await requireDirectoryPathIdentity(binding.lexical, opened, fileSystem);
  await requireDirectoryPathIdentity(binding.canonical, opened, fileSystem);
}

const SYSTEM_OWNED_DIRECTORY_FILE_SYSTEM: OwnedDirectoryFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
  openDirectory: openDirectoryNoFollow,
};

function requireCurrentOwner(uid: bigint, label: string): void {
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : uid;
  if (uid !== currentUid) throw new Error(`${label} must be owned by the current user.`);
}

export async function assertLocalFileSystem(
  path: string,
  label: string,
  probe: LocalFileSystemProbe = SYSTEM_FILE_SYSTEM_PROBE,
): Promise<void> {
  if (probe.platform === "darwin") {
    let mount: Awaited<ReturnType<LocalFileSystemProbe["inspectDarwinMount"]>>;
    try {
      mount = await probe.inspectDarwinMount(path);
    } catch {
      throw new Error(`${label} cannot establish that it is stored on a local filesystem.`);
    }
    if (mount === null || mount.fileSystemType.trim() === "") {
      throw new Error(`${label} cannot establish that it is stored on a local filesystem.`);
    }
    const fileSystemType = mount.fileSystemType.trim().toLowerCase();
    if (!mount.local || DARWIN_NETWORK_FILE_SYSTEMS.has(fileSystemType)) {
      throw new Error(`${label} must not be stored on a network filesystem.`);
    }
    return;
  }

  if (probe.platform === "linux") {
    const type = await probe.statFsType(path);
    if (LINUX_NETWORK_FILE_SYSTEMS.has(type)) {
      throw new Error(`${label} must not be stored on a network filesystem.`);
    }
    return;
  }

  throw new Error(`${label} cannot establish that it is stored on a local filesystem.`);
}

const DARWIN_NETWORK_FILE_SYSTEMS = new Set(["nfs", "smbfs", "webdav"]);
const LINUX_NETWORK_FILE_SYSTEMS = new Set([0x6969n, 0x517bn, 0xff534d42n]);

const SYSTEM_FILE_SYSTEM_PROBE: LocalFileSystemProbe = {
  platform: process.platform,
  statFsType: async (path) => BigInt((await statfs(path, { bigint: true })).type),
  inspectDarwinMount,
};

async function inspectDarwinMount(
  path: string,
): Promise<{ readonly fileSystemType: string; readonly local: boolean } | null> {
  const mounted = parseDarwinDf(await runDarwinDf(["-P", "-Y", path]));
  if (mounted === null) return null;
  const local = parseDarwinDf(await runDarwinDf(["-l", "-P", "-Y", path]));
  return {
    fileSystemType: mounted.fileSystemType,
    local: local !== null
      && local.source === mounted.source
      && local.fileSystemType === mounted.fileSystemType,
  };
}

function runDarwinDf(args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(
      "/bin/df",
      [...args],
      {
        encoding: "utf8",
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        maxBuffer: 64 * 1024,
      },
      (error, stdout) => {
        if (error) rejectOutput(error);
        else resolveOutput(stdout);
      },
    );
  });
}

function parseDarwinDf(
  output: string,
): { readonly source: string; readonly fileSystemType: string } | null {
  const lines = output.trimEnd().split("\n");
  if (lines.length !== 2) return null;
  const [header, row] = lines;
  if (header === undefined || row === undefined) return null;
  const typeOffset = header.indexOf("Type");
  const blocksOffset = header.indexOf("512-blocks", typeOffset + 4);
  if (typeOffset <= 0 || blocksOffset <= typeOffset) return null;
  const source = row.slice(0, typeOffset).trim();
  const fileSystemType = row.slice(typeOffset, blocksOffset).trim();
  return source !== "" && fileSystemType !== "" ? { source, fileSystemType } : null;
}

async function rejectGlobalHomeAlias(path: string): Promise<void> {
  const canonical = await canonicalizePotentialPath(path);
  const userHome = await canonicalizePotentialPath(homedir());
  const globalCodexHome = await canonicalizePotentialPath(
    process.env.CODEX_HOME ?? join(userHome, ".codex"),
  );
  if (canonical === userHome || canonical === globalCodexHome) {
    throw new Error("Codex profile home must not alias a global home.");
  }
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(await realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

function codexHomeDirectoryChain(codexHome: string): {
  readonly appHome: string;
  readonly providers: string;
  readonly codex: string;
  readonly home: string;
  readonly homeId: CodexHomeId;
} {
  const home = resolve(codexHome);
  const homeId = parseCodexHomeId(basename(home));
  const codex = dirname(home);
  const providers = dirname(codex);
  const appHome = dirname(providers);
  if (
    basename(codex) !== "codex"
    || basename(providers) !== "providers"
    || join(appHome, "providers", "codex", homeId) !== home
  ) {
    throw new Error("Codex profile home must remain beneath the canonical Orcode app home.");
  }
  return { appHome, providers, codex, home, homeId };
}

function requireExactCodexHomeChain(
  appHome: OwnedDirectoryBinding,
  providers: OwnedDirectoryBinding,
  codex: OwnedDirectoryBinding,
  home: OwnedDirectoryBinding,
  homeId: CodexHomeId,
): void {
  if (
    providers.canonical !== join(appHome.canonical, "providers")
    || codex.canonical !== join(providers.canonical, "codex")
    || home.canonical !== join(codex.canonical, homeId)
  ) {
    throw new Error("Codex profile home must remain beneath the canonical Orcode app home.");
  }
}

async function assertExactCodexConfig(configPath: string): Promise<void> {
  const config = await lstat(configPath, { bigint: true });
  if (!config.isFile() || config.isSymbolicLink()) {
    throw new Error("Codex profile config must be a regular file, not a symlink.");
  }
  requireCurrentOwner(config.uid, "Codex profile config");
  if ((Number(config.mode) & 0o077) !== 0) {
    throw new Error("Codex profile config permissions must be owner-only.");
  }
  if (config.nlink !== 1n) {
    throw new Error("Codex profile config must not be hard-linked.");
  }
  const handle = await open(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || opened.dev !== config.dev
      || opened.ino !== config.ino
      || opened.nlink !== 1n
    ) {
      throw new Error("Codex profile config changed during validation.");
    }
    const bytes = await handle.readFile("utf8");
    if (bytes !== CODEX_CONFIG) {
      throw new Error("Codex profile config must contain only the file credential-store setting.");
    }
  } finally {
    await handle.close();
  }
}

export async function assertOwnerOnlyProfileTree(
  directory: string,
  fileSystem: ProfileTreeFileSystem = SYSTEM_PROFILE_TREE_FILE_SYSTEM,
): Promise<void> {
  const traversal: ProfileTreeTraversal = { directories: [], files: [] };
  await inspectOwnerOnlyProfileTree(directory, fileSystem, traversal);
  for (const child of traversal.directories) {
    await requireDirectoryPathIdentity(child.path, child.metadata, fileSystem);
    const finalEntries = await fileSystem.readdir(child.path);
    await requireDirectoryPathIdentity(child.path, child.metadata, fileSystem);
    requireSameProfileEntrySet(child.entries, finalEntries);
  }
  for (const file of traversal.files) {
    await requireProfileFilePathIdentity(file.path, file.metadata, fileSystem);
  }
}

interface ProfileTreeTraversal {
  readonly directories: Array<{
    readonly path: string;
    readonly metadata: BigIntStats;
    readonly entries: readonly string[];
  }>;
  readonly files: Array<{
    readonly path: string;
    readonly metadata: BigIntStats;
  }>;
}

async function inspectOwnerOnlyProfileTree(
  directory: string,
  fileSystem: ProfileTreeFileSystem,
  traversal: ProfileTreeTraversal,
): Promise<void> {
  const lexical = await fileSystem.lstat(directory);
  requireSafeProfileDirectory(lexical);
  const handle = await fileSystem.openDirectory(directory);
  try {
    const opened = await handle.stat({ bigint: true });
    requireSameDirectoryIdentity(lexical, opened);
    await requireDirectoryPathIdentity(directory, opened, fileSystem);
    const entries = await fileSystem.readdir(directory);
    await requireDirectoryPathIdentity(directory, opened, fileSystem);
    traversal.directories.push({ path: directory, metadata: opened, entries: [...entries] });

    for (const entry of entries) {
      const path = join(directory, entry);
      const metadata = await fileSystem.lstat(path);
      requireCurrentOwner(metadata.uid, "Codex profile entry");
      if (metadata.isSymbolicLink()) {
        throw new Error("Codex profile entries must not be symlinks.");
      }
      if (metadata.isDirectory()) {
        requireSafeProfileDirectory(metadata);
        await assertLocalFileSystem(path, "Codex profile directory");
        await inspectOwnerOnlyProfileTree(path, fileSystem, traversal);
        await requireDirectoryPathIdentity(path, metadata, fileSystem);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Codex profile entries must be regular files or directories.");
      }
      requireSafeProfileFile(metadata);
      await requireProfileFilePathIdentity(path, metadata, fileSystem);
      traversal.files.push({ path, metadata });
    }

    const finalEntries = await fileSystem.readdir(directory);
    await requireDirectoryPathIdentity(directory, opened, fileSystem);
    requireSameProfileEntrySet(entries, finalEntries);
    await requireDirectoryPathIdentity(directory, opened, fileSystem);
  } finally {
    await handle.close();
  }
}

const SYSTEM_PROFILE_TREE_FILE_SYSTEM: ProfileTreeFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  readdir,
  openDirectory: openDirectoryNoFollow,
};

function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  return open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
}

function requireSafeProfileDirectory(metadata: BigIntStats): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Codex profile entries must not be symlinks.");
  }
  requireCurrentOwner(metadata.uid, "Codex profile directory");
  if ((Number(metadata.mode) & 0o777) !== DIRECTORY_MODE) {
    throw new Error("Codex profile directory permissions must be owner-only 0700.");
  }
}

function requireSafeProfileFile(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Codex profile entries must be regular files, not symlinks.");
  }
  requireCurrentOwner(metadata.uid, "Codex profile file");
  if ((Number(metadata.mode) & 0o777) !== FILE_MODE) {
    throw new Error("Codex profile file permissions must be owner-only 0600.");
  }
  if (metadata.nlink !== 1n) {
    throw new Error("Codex profile file must not be hard-linked.");
  }
}

async function requireProfileFilePathIdentity(
  path: string,
  expected: BigIntStats,
  fileSystem: Pick<ProfileTreeFileSystem, "lstat">,
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await fileSystem.lstat(path);
  } catch {
    throw new Error("Codex profile file changed during validation.");
  }
  requireSameProfileFileIdentity(expected, current);
}

function requireSameProfileFileIdentity(expected: BigIntStats, actual: BigIntStats): void {
  try {
    requireSafeProfileFile(actual);
  } catch {
    throw new Error("Codex profile file changed during validation.");
  }
  if (
    expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.uid !== actual.uid
    || expected.mode !== actual.mode
    || expected.nlink !== actual.nlink
  ) {
    throw new Error("Codex profile file changed during validation.");
  }
}

function requireSameProfileEntrySet(before: readonly string[], after: readonly string[]): void {
  const expected = [...before].sort();
  const actual = [...after].sort();
  if (expected.length !== actual.length || expected.some((entry, index) => entry !== actual[index])) {
    throw new Error("Codex profile directory entries changed during validation.");
  }
}

async function requireDirectoryPathIdentity(
  path: string,
  expected: BigIntStats,
  fileSystem: Pick<OwnedDirectoryFileSystem, "lstat">,
): Promise<void> {
  let current: BigIntStats;
  try {
    current = await fileSystem.lstat(path);
  } catch {
    throw new Error("Codex profile directory changed during validation.");
  }
  requireSameDirectoryIdentity(expected, current);
}

function requireSameDirectoryIdentity(expected: BigIntStats, actual: BigIntStats): void {
  if (
    !actual.isDirectory()
    || actual.isSymbolicLink()
    || expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.uid !== actual.uid
    || expected.mode !== actual.mode
  ) {
    throw new Error("Codex profile directory changed during validation.");
  }
}

function assertDirectChild(appHome: string, candidate: string): void {
  const suffix = relative(appHome, candidate);
  if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || resolve(candidate) !== candidate) {
    throw new Error("Codex profile home must remain beneath the canonical Orcode app home.");
  }
}

async function writeExactConfig(path: string): Promise<void> {
  try {
    await lstat(path);
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }

  const temporary = join(dirname(path), `.config.toml.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      FILE_MODE,
    );
    await handle.writeFile(CODEX_CONFIG, "utf8");
    await handle.sync();
    await handle.chmod(FILE_MODE);
    await handle.close();
    handle = null;
    await link(temporary, path);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
