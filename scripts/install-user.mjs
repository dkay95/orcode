import { chmod, lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultFileSystem = { chmod, lstat, mkdir, readlink, symlink, unlink };
const defaultProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function isInstallerEntrypoint(
  moduleUrl,
  argvEntry = process.argv[1],
  resolvePath = resolve,
) {
  if (!argvEntry) return false;
  try {
    return pathToFileURL(resolvePath(argvEntry)).href === moduleUrl;
  } catch {
    return false;
  }
}

export async function installUserAliases(options = {}) {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot);
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const log = options.log ?? console.log;
  const target = join(projectRoot, "dist", "cli.js");
  const binDirectory = join(homeDirectory, ".local", "bin");
  const aliases = ["orcode", "routercode"].map((name) => ({
    name,
    link: join(binDirectory, name),
  }));

  const preflight = [];
  let firstFailure;
  for (const alias of aliases) {
    try {
      const info = await fileSystem.lstat(alias.link);
      if (!info.isSymbolicLink()) {
        throw new Error(
          `${alias.link} existiert und ist kein Symlink. Es wurde nichts überschrieben.`,
        );
      }
      const current = resolve(dirname(alias.link), await fileSystem.readlink(alias.link));
      if (current !== target) {
        throw new Error(
          `${alias.link} zeigt bereits auf ${current}. Es wurde nichts überschrieben.`,
        );
      }
      preflight.push({ ...alias, exists: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        preflight.push({ ...alias, exists: false });
      } else {
        firstFailure ??= error;
      }
    }
  }

  if (firstFailure) throw firstFailure;

  await fileSystem.mkdir(binDirectory, { recursive: true, mode: 0o755 });
  await fileSystem.chmod(target, 0o755);

  const created = [];
  try {
    for (const alias of preflight) {
      if (alias.exists) continue;
      await fileSystem.symlink(target, alias.link);
      const createdAlias = { ...alias, identity: null };
      created.push(createdAlias);
      const info = await fileSystem.lstat(alias.link);
      if (!info.isSymbolicLink()) {
        throw new Error(`${alias.link} wurde nicht als Symlink angelegt.`);
      }
      const current = resolve(dirname(alias.link), await fileSystem.readlink(alias.link));
      if (current !== target) {
        throw new Error(`${alias.link} wurde mit einem unerwarteten Ziel angelegt.`);
      }
      createdAlias.identity = fileIdentity(info);
    }
  } catch (installError) {
    const rollbackErrors = [];
    for (const alias of [...created].reverse()) {
      try {
        await rollbackCreatedAlias(fileSystem, alias, target);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [installError, ...rollbackErrors],
        `Alias-Installation fehlgeschlagen und konnte nicht sicher vollständig ` +
          `zurückgerollt werden. Ausgangsfehler: ${errorMessage(installError)}. ` +
          `Rückrollen: ${rollbackErrors.map(errorMessage).join("; ")}`,
        { cause: installError },
      );
    }
    throw installError;
  }

  for (const alias of preflight) {
    log(
      alias.exists
        ? `${alias.name} ist bereits installiert: ${alias.link}`
        : `${alias.name} installiert: ${alias.link}`,
    );
  }
}

async function rollbackCreatedAlias(fileSystem, alias, target) {
  let info;
  try {
    info = await fileSystem.lstat(alias.link);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (!info.isSymbolicLink()) {
    throw new Error(
      `Unsicheres Rückrollen abgelehnt: ${alias.link} ist nicht mehr der angelegte Symlink.`,
    );
  }
  const current = resolve(dirname(alias.link), await fileSystem.readlink(alias.link));
  if (current !== target) {
    throw new Error(
      `Unsicheres Rückrollen abgelehnt: ${alias.link} zeigt nicht mehr auf das angelegte Ziel.`,
    );
  }
  const currentIdentity = fileIdentity(info);
  if (
    alias.identity !== null &&
    (currentIdentity === null || currentIdentity !== alias.identity)
  ) {
    throw new Error(
      `Unsicheres Rückrollen abgelehnt: ${alias.link} wurde nach dem Anlegen ausgetauscht.`,
    );
  }
  await fileSystem.unlink(alias.link);
}

function fileIdentity(info) {
  const validPart = (value) => typeof value === "number" || typeof value === "bigint";
  return validPart(info.dev) && validPart(info.ino)
    ? `${String(info.dev)}:${String(info.ino)}`
    : null;
}

function hasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (isInstallerEntrypoint(import.meta.url)) {
  await installUserAliases();
}
