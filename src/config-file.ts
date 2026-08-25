import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { hasCode } from "./utils.js";

type ConfigParentSnapshot =
  | { readonly kind: "absent" }
  | { readonly kind: "directory"; readonly dev: bigint; readonly ino: bigint };

export type ConfigFileSnapshot =
  | {
    readonly kind: "absent";
    readonly parent: ConfigParentSnapshot;
  }
  | {
    readonly kind: "file";
    readonly dev: bigint;
    readonly ino: bigint;
    readonly raw: string;
    readonly parent: ConfigParentSnapshot & { readonly kind: "directory" };
  };

export interface ConfigLockTargetIdentity {
  readonly canonicalPath: string;
  readonly identityKey: string;
}

/**
 * Uses the real parent spelling for one stable path-wide writer key while
 * retaining the caller's absolute path for PrivateStore boundary checks.
 */
export async function resolveConfigLockTarget(
  path: string,
): Promise<ConfigLockTargetIdentity> {
  const absolute = resolve(path);
  const parentPath = dirname(absolute);
  const parent = await readParentSnapshot(parentPath);
  const canonicalParent = await canonicalizeDirectory(parentPath);
  await assertParentSnapshot(parentPath, parent);
  return Object.freeze({
    canonicalPath: absolute,
    identityKey: `path:${canonicalParent.toLowerCase()}:${basename(absolute).toLowerCase()}`,
  });
}

/** Reads one exact regular config file without following a target symlink. */
export async function readConfigFileSnapshot(
  path: string,
): Promise<ConfigFileSnapshot> {
  const parent = await readParentSnapshot(dirname(path));
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      await assertParentSnapshot(dirname(path), parent);
      return Object.freeze({ kind: "absent", parent });
    }
    throw new Error("Config target identity could not be verified.");
  }
  if (parent.kind !== "directory") {
    throw new Error("Config target identity could not be verified.");
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("Config target must be one regular file.");
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    assertSameConfigIdentity(before, opened);
    const raw = await handle.readFile("utf8");
    const afterHandle = await handle.stat({ bigint: true });
    assertSameConfigIdentity(before, afterHandle);
    const afterPath = await lstat(path, { bigint: true });
    assertSameConfigIdentity(before, afterPath);
    await assertParentSnapshot(dirname(path), parent);
    return Object.freeze({
      kind: "file",
      dev: before.dev,
      ino: before.ino,
      raw,
      parent,
    });
  } catch {
    throw new Error("Config target identity could not be verified.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Revalidates the exact regular file (or absence) captured before publish. */
export async function assertConfigFileSnapshot(
  path: string,
  snapshot: ConfigFileSnapshot,
): Promise<void> {
  await assertParentSnapshot(dirname(path), snapshot.parent);
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (snapshot.kind === "absent" && hasCode(error, "ENOENT")) {
      await assertParentSnapshot(dirname(path), snapshot.parent);
      return;
    }
    throw new Error("Config target changed before publication.");
  }
  if (snapshot.kind === "absent"
    || current.isSymbolicLink()
    || !current.isFile()
    || current.dev !== snapshot.dev
    || current.ino !== snapshot.ino) {
    throw new Error("Config target changed before publication.");
  }
  await assertParentSnapshot(dirname(path), snapshot.parent);
}

/**
 * Exact raw-byte snapshot equality: absence with the same parent identity, or
 * the same regular file (dev/inode/parent) carrying byte-identical content.
 * Unlike `assertConfigFileSnapshot()` this also catches a same-inode edit.
 */
export function sameConfigFileSnapshot(
  left: ConfigFileSnapshot,
  right: ConfigFileSnapshot,
): boolean {
  if (!sameParentSnapshot(left.parent, right.parent)) return false;
  if (left.kind === "absent" || right.kind === "absent") {
    return left.kind === right.kind;
  }
  return left.dev === right.dev
    && left.ino === right.ino
    && left.raw === right.raw;
}

function sameParentSnapshot(
  left: ConfigParentSnapshot,
  right: ConfigParentSnapshot,
): boolean {
  if (left.kind === "absent" || right.kind === "absent") {
    return left.kind === right.kind;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

async function canonicalizeDirectory(directory: string): Promise<string> {
  let cursor = resolve(directory);
  const missing: string[] = [];
  while (true) {
    let before: Awaited<ReturnType<typeof lstat>>;
    try {
      before = await lstat(cursor, { bigint: true });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        throw new Error("Config parent identity could not be verified.");
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new Error("Config parent identity could not be verified.");
      }
      missing.unshift(basename(cursor));
      cursor = parent;
      continue;
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error("Config parent must be one real directory.");
    }
    let canonical: string;
    try {
      canonical = await realpath(cursor);
      const after = await lstat(cursor, { bigint: true });
      if (after.isSymbolicLink() || !after.isDirectory()
        || after.dev !== before.dev || after.ino !== before.ino) {
        throw new Error("config-parent-changed");
      }
    } catch {
      throw new Error("Config parent identity could not be verified.");
    }
    return join(canonical, ...missing);
  }
}

async function readParentSnapshot(path: string): Promise<ConfigParentSnapshot> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return Object.freeze({ kind: "absent" });
    throw new Error("Config parent identity could not be verified.");
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("Config parent must be one real directory.");
  }
  return Object.freeze({ kind: "directory", dev: before.dev, ino: before.ino });
}

async function assertParentSnapshot(
  path: string,
  snapshot: ConfigParentSnapshot,
): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (snapshot.kind === "absent" && hasCode(error, "ENOENT")) return;
    throw new Error("Config target changed before publication.");
  }
  if (snapshot.kind !== "directory"
    || current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== snapshot.dev
    || current.ino !== snapshot.ino) {
    throw new Error("Config target changed before publication.");
  }
}

function assertSameConfigIdentity(
  expected: { dev: bigint; ino: bigint; isFile(): boolean; isSymbolicLink(): boolean },
  actual: { dev: bigint; ino: bigint; isFile(): boolean; isSymbolicLink(): boolean },
): void {
  if (actual.isSymbolicLink() || !actual.isFile()
    || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("Config target identity changed.");
  }
}
