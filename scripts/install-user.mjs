import { chmod, lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(projectRoot, "dist", "cli.js");
const binDirectory = join(homedir(), ".local", "bin");
const link = join(binDirectory, "routercode");

await mkdir(binDirectory, { recursive: true, mode: 0o755 });
await chmod(target, 0o755);

try {
  const info = await lstat(link);
  if (!info.isSymbolicLink()) {
    throw new Error(`${link} existiert und ist kein Symlink. Es wurde nichts überschrieben.`);
  }
  const current = resolve(dirname(link), await readlink(link));
  if (current !== target) {
    throw new Error(`${link} zeigt bereits auf ${current}. Es wurde nichts überschrieben.`);
  }
  console.log(`RouterCode ist bereits installiert: ${link}`);
} catch (error) {
  if (!hasCode(error, "ENOENT")) {
    throw error;
  }
  await symlink(target, link);
  console.log(`RouterCode installiert: ${link}`);
}

function hasCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
