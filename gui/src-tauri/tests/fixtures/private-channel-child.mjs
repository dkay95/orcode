import { execFile, spawn } from "node:child_process";
import { fstatSync, readFileSync, readSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACTION_FD = 198;
const CONTROL_FD = 199;
const ACTION_TAG = 0xa1;
const CONTROL_TAG = 0xc1;

function execFilePromise(args) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/python3", args, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function runSite(site, stdio, actionIdentity, controlIdentity) {
  const nonce = `${process.pid}-${site}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const immediatePath = join(tmpdir(), `orcode-private-fd-immediate-${nonce}.json`);
  const grandchildPath = join(tmpdir(), `orcode-private-fd-grandchild-${nonce}.json`);
  // Check before opening the report file, then spawn a real descendant which
  // execs a fresh interpreter and checks again before opening its own report.
  // Unlike Node itself, these tiny executables do not allocate event-loop
  // descriptors before the assertion, so EBADF identifies inheritance rather
  // than runtime reuse.
  const grandchild = [
    "import json, os, sys",
    "def original_gone(fd, dev, ino):",
    "  try:",
    "    value = os.fstat(fd); return value.st_dev != int(dev) or value.st_ino != int(ino)",
    "  except OSError as e: return e.errno == 9",
    "report = {'actionClosed': original_gone(198, sys.argv[3], sys.argv[4]), 'controlClosed': original_gone(199, sys.argv[5], sys.argv[6]), 'distinctProcess': os.getpid() != int(sys.argv[2])}",
    "with open(sys.argv[1], 'w') as f: json.dump(report, f)",
  ].join("\n");
  const child = [
    "import json, os, subprocess, sys",
    "def original_gone(fd, dev, ino):",
    "  try:",
    "    value = os.fstat(fd); return value.st_dev != int(dev) or value.st_ino != int(ino)",
    "  except OSError as e: return e.errno == 9",
    `completed = subprocess.run([sys.executable, '-c', ${JSON.stringify(grandchild)}, sys.argv[3], str(os.getpid()), sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7]], close_fds=False)`,
    "report = {'site': sys.argv[1], 'actionClosed': original_gone(198, sys.argv[4], sys.argv[5]), 'controlClosed': original_gone(199, sys.argv[6], sys.argv[7]), 'grandchildExit': completed.returncode if completed.returncode >= 0 else None, 'grandchildSignal': -completed.returncode if completed.returncode < 0 else None}",
    "with open(sys.argv[2], 'w') as f: json.dump(report, f)",
  ].join("\n");
  const args = ["-c", child, site, immediatePath, grandchildPath, ...actionIdentity, ...controlIdentity];
  try {
    if (stdio === "default-execfile") {
      await execFilePromise(args);
    } else {
      const child = spawn("/usr/bin/python3", args, { stdio });
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0 && signal === null) resolve();
          else reject(new Error(`${site} exited code=${code} signal=${signal}`));
        });
      });
    }
    return {
      ...JSON.parse(readFileSync(immediatePath, "utf8")),
      grandchild: JSON.parse(readFileSync(grandchildPath, "utf8")),
    };
  } finally {
    for (const path of [immediatePath, grandchildPath]) {
      try { unlinkSync(path); } catch {}
    }
  }
}

function readExactly(fd, length) {
  const output = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, output, offset, length - offset, null);
    if (count === 0) throw new Error("truncated private frame");
    offset += count;
  }
  return output;
}

function readFrame(fd, expectedTag) {
  const header = readExactly(fd, 5);
  if (header[0] !== expectedTag) throw new Error("wrong private frame direction");
  const length = header.readUInt32BE(1);
  if (length > 4096) throw new Error("oversize private frame");
  return readExactly(fd, length);
}

function writeFrame(fd, tag, payload) {
  const bytes = Buffer.from(payload);
  const header = Buffer.alloc(5);
  header[0] = tag;
  header.writeUInt32BE(bytes.length, 1);
  writeSync(fd, header);
  writeSync(fd, bytes);
}

async function main() {
  const actionStat = fstatSync(ACTION_FD, { bigint: true });
  const controlStat = fstatSync(CONTROL_FD, { bigint: true });
  const actionIdentity = [actionStat.dev.toString(), actionStat.ino.toString()];
  const controlIdentity = [controlStat.dev.toString(), controlStat.ino.toString()];
  const control = readFrame(CONTROL_FD, CONTROL_TAG);
  writeFrame(ACTION_FD, ACTION_TAG, control);

  const sites = [];
  sites.push(await runSite("voice", ["ignore", "ignore", "pipe"], actionIdentity, controlIdentity));
  sites.push(await runSite("workspace", ["ignore", "pipe", "pipe"], actionIdentity, controlIdentity));
  sites.push(await runSite("private-store", ["ignore", "pipe", "pipe"], actionIdentity, controlIdentity));
  sites.push(await runSite("browser-engine", "ignore", actionIdentity, controlIdentity));
  sites.push(await runSite("cli-image-picker", "default-execfile", actionIdentity, controlIdentity));

  process.stdout.write(`${JSON.stringify({
    sites,
  })}\n`);
}

await main();
