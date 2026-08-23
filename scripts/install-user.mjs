import { chmod, lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultFileSystem = { chmod, lstat, mkdir, readlink, symlink };
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

  for (const alias of preflight) {
    if (alias.exists) {
      log(`${alias.name} ist bereits installiert: ${alias.link}`);
    } else {
      await fileSystem.symlink(target, alias.link);
      log(`${alias.name} installiert: ${alias.link}`);
    }
  }
}

function hasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

if (isInstallerEntrypoint(import.meta.url)) {
  await installUserAliases();
}
