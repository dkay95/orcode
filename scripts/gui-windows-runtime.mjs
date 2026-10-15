// Build-time inventory only. This module never creates native owner/publisher authority.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const PIN = Object.freeze(JSON.parse(readFileSync(new URL('./gui-runtime.windows.json', import.meta.url), 'utf8')));
const HASH = /^[0-9a-f]{64}$/;
const REQUIRED = ['node.exe', 'orcode-platform-host.exe', 'dist/gui-server.js', 'package.json'];
const MAX_FILE_BYTES = 512 * 1024 ** 2;
const MAX_RUNTIME_BYTES = 2 * 1024 ** 3;
const SENSITIVE = /^(?:\.orcode|\.codex|\.claude|\.devhome|\.env(?:\..*)?|auth\.json|credentials(?:\.json)?)$/i;

function invalid(reason) { throw new TypeError(`Windows runtime ${reason}.`); }
function record(value, keys) {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) invalid('record invalid');
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) invalid('keys invalid');
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid('properties invalid');
  }
  return value;
}

export function validateWindowsRuntimePin(value) {
  const input = record(value, Object.keys(PIN));
  if (Object.keys(PIN).some(key => input[key] !== PIN[key])) invalid('pin mismatch');
  return Object.freeze({ ...PIN });
}

function safePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2048 || path.normalize('NFC') !== path
    || /[\u0000-\u001f\u007f\\:<>"|?*]/.test(path)) invalid('path invalid');
  const segments = path.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(segment) || SENSITIVE.test(segment)) invalid('path alias or private data');
  }
  if (!REQUIRED.includes(path) && !path.startsWith('dist/') && !path.startsWith('node_modules/')) invalid('unexpected root file');
  return path;
}

export function canonicalRuntimeManifest(value) {
  const input = record(value, ['schemaVersion', 'platform', 'arch', 'nodeVersion', 'files']);
  if (input.schemaVersion !== 1 || input.platform !== 'win32' || input.arch !== 'x64' || input.nodeVersion !== PIN.version
    || !Array.isArray(input.files) || Object.getPrototypeOf(input.files) !== Array.prototype
    || input.files.length > 100_000 || Reflect.ownKeys(input.files).length !== input.files.length + 1) invalid('manifest target or files invalid');
  const files = [];
  const seen = new Set();
  let total = 0;
  for (let index = 0; index < input.files.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input.files, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid('file array invalid');
    const file = record(descriptor.value, ['path', 'bytes', 'sha256']);
    const path = safePath(file.path);
    const folded = path.toUpperCase();
    if (seen.has(folded) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES
      || typeof file.sha256 !== 'string' || !HASH.test(file.sha256)) invalid('file identity invalid');
    seen.add(folded);
    total += file.bytes;
    if (total > MAX_RUNTIME_BYTES) invalid('inventory too large');
    files.push(Object.freeze({ path, bytes: file.bytes, sha256: file.sha256 }));
  }
  for (const path of REQUIRED) if (!files.some(file => file.path === path)) invalid(`missing ${path === 'orcode-platform-host.exe' ? 'helper' : path}`);
  if (!files.some(file => file.path.startsWith('node_modules/'))) invalid('missing production dependencies');
  if (files.find(file => file.path === 'node.exe').sha256 !== PIN.nodeSha256) invalid('Node checksum mismatch');
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return Object.freeze({ schemaVersion: 1, platform: 'win32', arch: 'x64', nodeVersion: PIN.version, files: Object.freeze(files) });
}

export function serializeRuntimeManifest(value) { return `${JSON.stringify(canonicalRuntimeManifest(value), null, 2)}\n`; }
export function runtimeManifestDigest(value) { return createHash('sha256').update(serializeRuntimeManifest(value)).digest('hex'); }

function peX64(path) {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(64);
    if (readSync(fd, header, 0, header.length, 0) !== 64 || header.readUInt16LE(0) !== 0x5a4d) return false;
    const offset = header.readUInt32LE(0x3c);
    if (offset < 64 || offset > 1024 * 1024) return false;
    const pe = Buffer.alloc(26);
    return readSync(fd, pe, 0, pe.length, offset) === pe.length && pe.readUInt32LE(0) === 0x4550
      && pe.readUInt16LE(4) === 0x8664 && pe.readUInt16LE(24) === 0x20b;
  } finally { closeSync(fd); }
}

function hashFile(path, size) {
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== size || before.nlink !== 1) invalid('staging object changed');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let read = 0;
    while (read < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - read), null);
      if (count === 0) invalid('staging file truncated');
      hash.update(buffer.subarray(0, count)); read += count;
    }
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.nlink !== 1) invalid('staging object changed');
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

export function collectWindowsRuntimeManifest(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) invalid('absolute staging root required');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) invalid('staging root invalid');
  const entries = [];
  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === 'runtime-manifest.json') continue; // Its exact bytes are hashed separately by the shell build.
      const target = join(directory, entry.name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) invalid('reparse/symlink in runtime');
      if (stat.isDirectory()) {
        if ((!prefix && path !== 'dist' && path !== 'node_modules') || SENSITIVE.test(entry.name)) invalid('private or unexpected directory');
        visit(target, path);
      } else {
        safePath(path);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || entries.length >= 100_000) invalid('staging file invalid');
        entries.push({ path, bytes: stat.size, target });
      }
    }
  }
  visit(root, '');
  if (!entries.some(entry => entry.path === 'orcode-platform-host.exe')) invalid('missing helper');
  // Reject foreign .node files before considering executable hashes; a Mac dependency tree is never reusable.
  for (const entry of entries) if (entry.path.endsWith('.node') && !peX64(entry.target)) invalid('native addon is not Windows PE x64');
  for (const name of ['node.exe', 'orcode-platform-host.exe']) {
    const entry = entries.find(entry => entry.path === name);
    if (!entry || !peX64(entry.target)) invalid(`${name} is not Windows PE x64`);
  }
  return canonicalRuntimeManifest({ schemaVersion: 1, platform: 'win32', arch: 'x64', nodeVersion: PIN.version,
    files: entries.map(({ path, bytes, target }) => ({ path, bytes, sha256: hashFile(target, bytes) })) });
}
