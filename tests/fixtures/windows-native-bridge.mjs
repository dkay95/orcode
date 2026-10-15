// Account-free real-process integration fixture. No models, credentials or GUI authority.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const context = JSON.parse(process.env.ORCODE_BRIDGE_CONTEXT);
const helper = spawn(context.helper, ['--owner-pid', String(context.ownerPid), '--owner-time', context.ownerTime,
  '--engine-pid', String(process.pid), '--generation', String(context.generation), '--pipe', context.pipe, '--instance', context.instance],
  { stdio: ['pipe', 'pipe', 'ignore'], env: { SystemRoot: process.env.SystemRoot }, windowsHide: true });
const token = () => randomBytes(24).toString('base64url');
const hello = { kind: 'windows-owner-hello', version: 1, requestId: token(), sessionId: token(), challenge: token(),
  childPid: process.pid, childGeneration: context.mode === 'wrong-generation' ? 8 : context.generation,
  pipeInstanceId: context.instance, deadlineAt: Date.now() + (context.mode === 'expired' ? -1 : 20_000) };
function frame(tag, value) {
  const payload = Buffer.from(JSON.stringify(value)); const output = Buffer.alloc(5 + payload.length);
  output[0] = tag; output.writeUInt32BE(payload.length, 1); payload.copy(output, 5); return output;
}
helper.stdin.on('error', () => {});
helper.on('error', () => process.exit(1));
helper.stdin.write(frame(0xb0, hello));
let pending = Buffer.alloc(0); let attested = false;
helper.stdout.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 5) {
    const size = pending.readUInt32BE(1); if (size > 4096) process.exit(1);
    if (pending.length < 5 + size) return;
    const tag = pending[0]; const value = JSON.parse(pending.subarray(5, 5 + size).toString('utf8')); pending = pending.subarray(5 + size);
    if (!attested) {
      if (tag !== 0xb1 || value.kind !== 'windows-owner-attestation' || value.childPid !== process.pid
        || value.peerPid !== helper.pid || value.ownerPid !== context.ownerPid || value.ownerCreationTime !== context.ownerTime
        || value.childGeneration !== context.generation || value.challenge !== hello.challenge || value.pipeInstanceId !== hello.pipeInstanceId) process.exit(1);
      attested = true; helper.stdin.write(frame(0xa1, { fixture: 'private-action' }));
    } else {
      if (tag !== 0xc1 || value.fixture !== 'accepted') process.exit(1);
      writeFileSync(join(context.root, 'accepted'), 'private-control'); helper.stdin.end();
    }
  }
});
helper.on('exit', code => { process.exitCode = attested && code === 0 ? 0 : 1; });
const timeout = setTimeout(() => { helper.kill(); process.exit(1); }, 25_000); timeout.unref();
