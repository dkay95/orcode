import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KimiDesktopPermitReader } from "../src/kimi-desktop-permit.js";
import { createDesktopKimiRuntimeCapability, type DesktopKimiRuntimeCapability } from "../src/kimi-execution-origin.js";
import {
  NativeSidecarChannel,
  decodePrivateActionFrame,
  encodeControlFrame,
  type KimiDesktopControlRecord,
  type KimiNativeActionRequest,
  type NativeSidecarTransport,
} from "../src/native-sidecar-channel.js";

export async function createAttestedDesktopKimiFixture(options: Readonly<{
  generation: number;
  now: () => number;
  emitRequirement: DesktopKimiRuntimeCapability["emitRequirement"];
  onAction: (action: KimiNativeActionRequest) => KimiDesktopControlRecord | null | Promise<KimiDesktopControlRecord | null>;
  onRevoke?: (record: Exclude<ReturnType<typeof decodePrivateActionFrame>, { kind: "packaged-startup" } | KimiNativeActionRequest>) => void;
}>): Promise<Readonly<{
  capability: DesktopKimiRuntimeCapability;
  permitReader: KimiDesktopPermitReader;
  pushControl(control: KimiDesktopControlRecord): void;
  close(): Promise<void>;
}>> {
  const root = await mkdtemp(join(tmpdir(), "orcode-attested-desktop-"));
  const executablePath = join(root, "orcode-gui");
  const executable = Buffer.from("attested-desktop-kimi-fixture");
  await writeFile(executablePath, executable, { mode: 0o700 });
  const executableStat = await stat(executablePath);
  const controls: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  const transport: NativeSidecarTransport = {
    async writeAction(frame) {
      const record = decodePrivateActionFrame(frame);
      let controlWritten = false;
      if (record.kind === "packaged-startup") {
        controls.push(encodeControlFrame({
          ...record,
          kind: "packaged-attestation",
          generation: options.generation,
          executablePath,
          executableDevice: executableStat.dev,
          executableInode: executableStat.ino,
          executableSize: executableStat.size,
          policySha256: "a".repeat(64),
          executableSha256: createHash("sha256").update(executable).digest("hex"),
        }));
        controlWritten = true;
      } else if (record.kind !== "revoke") {
        const control = await options.onAction(record);
        if (control) { controls.push(encodeControlFrame(control)); controlWritten = true; }
      } else {
        options.onRevoke?.(record);
      }
      if (controlWritten) { wake?.(); wake = null; }
    },
    async readControl() {
      if (controls.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
      return controls.shift() ?? null;
    },
    close() { wake?.(); wake = null; },
  };
  const permitReader = new KimiDesktopPermitReader(new NativeSidecarChannel(transport), options.now);
  const attestation = await permitReader.consumePackagedStartup();
  const capability = createDesktopKimiRuntimeCapability(attestation, {
    permitReader,
    childPid: process.pid,
    generation: options.generation,
    now: options.now,
    emitRequirement: options.emitRequirement,
  });
  return Object.freeze({
    capability,
    permitReader,
    pushControl(control) { controls.push(encodeControlFrame(control)); wake?.(); wake = null; },
    async close() { permitReader.close("end"); await rm(root, { recursive: true, force: true }); },
  });
}
