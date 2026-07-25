import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeWav,
  createAudioRecorders,
  createArecordAudioRecorder,
  createFfmpegAudioRecorder,
  createParecordAudioRecorder,
  createProcessAudioRecorder,
  createSwiftAudioRecorder,
  deleteRecordedAudio,
  ensureSwiftRecorderCommand,
  ensureVoiceConsent,
  NoAudioRecorderAvailableError,
  selectAudioRecorder,
  swiftBinaryPath,
  type RecorderProcess,
  type SpawnFn,
} from "../src/voice.js";

/**
 * A pid that can never be a real process group on this machine (exceeds any
 * real PID range), so `process.kill(-pid, …)` inside voice.ts always throws
 * ESRCH and falls back to the fake's own `kill()` — tests never risk
 * signalling a real, unrelated process group.
 */
const SAFE_FAKE_PID = 2_147_483_647;

class FakeChildProcess extends EventEmitter implements RecorderProcess {
  readonly pid = SAFE_FAKE_PID;
  readonly stderr = new EventEmitter();
  killSignals: NodeJS.Signals[] = [];
  onKill?: (signal: NodeJS.Signals) => void;

  kill(signalName: NodeJS.Signals): boolean {
    this.killSignals.push(signalName);
    this.onKill?.(signalName);
    return true;
  }
}

function makeWavBuffer(samples: number[], sampleRate = 16_000, channels = 1): Buffer {
  const bitsPerSample = 16;
  const dataBytes = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  const data = Buffer.alloc(dataBytes);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  return Buffer.concat([header, data]);
}

function loudSamples(count: number, amplitude = 20_000): number[] {
  return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? amplitude : -amplitude));
}

/**
 * A fake `SpawnFn` that, when killed, writes `audioOnStop` to the requested
 * output path (the WAV recorder's usual behaviour: finalize the file when
 * signalled). `outputPath` is always the last CLI argument, matching the
 * contract `startProcessRecording` uses for every real provider.
 */
function fakeRecorderSpawn(options: {
  audioOnStop?: Buffer;
  writeImmediately?: boolean;
}): { spawnFn: SpawnFn; processes: FakeChildProcess[] } {
  const processes: FakeChildProcess[] = [];
  const spawnFn: SpawnFn = (_executable, args) => {
    const outputPath = args[args.length - 1] as string;
    const proc = new FakeChildProcess();
    processes.push(proc);
    const write = async () => {
      if (options.audioOnStop) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(outputPath, options.audioOnStop);
      }
    };
    if (options.writeImmediately) {
      void write();
    }
    proc.onKill = () => {
      void write().then(() => proc.emit("exit", 0, null));
    };
    return proc;
  };
  return { spawnFn, processes };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "routercode-voice-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("analyzeWav reports sample count, peak amplitude and duration", () => {
  const buffer = makeWavBuffer(loudSamples(1_600), 16_000, 1);
  const info = analyzeWav(buffer);
  assert.equal(info.sampleCount, 1_600);
  assert.ok(info.peakAmplitude > 0.5);
  assert.ok(Math.abs(info.durationMs - 100) < 2);
});

test("analyzeWav treats a header-only buffer as empty", () => {
  const info = analyzeWav(makeWavBuffer([]));
  assert.equal(info.sampleCount, 0);
});

test("stop() returns the finalized recording and quiet flag", async () => {
  await withTempRoot(async (root) => {
    const audio = makeWavBuffer(loudSamples(4_000));
    const { spawnFn } = fakeRecorderSpawn({ audioOnStop: audio });
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
    });
    const handle = await recorder.start();
    const result = await handle.stop();
    assert.equal(result.format, "wav");
    assert.equal(result.quiet, false);
    assert.ok(result.sizeBytes > 44);
    await deleteRecordedAudio(result);
  });
});

test("a quiet recording is flagged but not rejected", async () => {
  await withTempRoot(async (root) => {
    const audio = makeWavBuffer(loudSamples(4_000, 200)); // ~0.6% of full scale
    const { spawnFn } = fakeRecorderSpawn({ audioOnStop: audio });
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
    });
    const handle = await recorder.start();
    const result = await handle.stop();
    assert.equal(result.quiet, true);
    await deleteRecordedAudio(result);
  });
});

test("an empty recording is rejected with a clear German error", async () => {
  await withTempRoot(async (root) => {
    const { spawnFn } = fakeRecorderSpawn({ audioOnStop: makeWavBuffer([]) });
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
    });
    const handle = await recorder.start();
    await assert.rejects(handle.stop(), /leer/i);
  });
});

test("a microphone-permission failure becomes a specific German message", async () => {
  await withTempRoot(async (root) => {
    const spawnFn: SpawnFn = (_executable, _args) => {
      const proc = new FakeChildProcess();
      queueMicrotask(() => {
        proc.stderr.emit("data", "ORCODE_ERROR:PERMISSION_DENIED\n");
        proc.emit("exit", 2, null);
      });
      return proc;
    };
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
    });
    const handle = await recorder.start();
    await assert.rejects(handle.stop(), /Mikrofon/);
  });
});

test("no microphone found becomes a specific German message", async () => {
  await withTempRoot(async (root) => {
    const spawnFn: SpawnFn = (_executable, _args) => {
      const proc = new FakeChildProcess();
      queueMicrotask(() => {
        proc.stderr.emit("data", "ORCODE_ERROR:RECORDER_INIT_FAILED\n");
        proc.emit("exit", 3, null);
      });
      return proc;
    };
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
    });
    const handle = await recorder.start();
    await assert.rejects(handle.stop(), /kein Mikrofon gefunden/);
  });
});

test("cancel() deletes the temp file and never throws", async () => {
  await withTempRoot(async (root) => {
    const audio = makeWavBuffer(loudSamples(4_000));
    const { spawnFn, processes } = fakeRecorderSpawn({ audioOnStop: audio });
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
    });
    const handle = await recorder.start();
    await handle.cancel();
    assert.deepEqual(processes[0]?.killSignals, ["SIGTERM"]);
    const remaining = await readdir(root);
    assert.equal(remaining.length, 0);
  });
});

test("temp file is gone after deleteRecordedAudio", async () => {
  await withTempRoot(async (root) => {
    const audio = makeWavBuffer(loudSamples(4_000));
    const { spawnFn } = fakeRecorderSpawn({ audioOnStop: audio });
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
    });
    const handle = await recorder.start();
    const result = await handle.stop();
    await stat(result.path); // exists before cleanup
    await deleteRecordedAudio(result);
    await assert.rejects(stat(result.path));
    const remaining = await readdir(root);
    assert.equal(remaining.length, 0);
  });
});

test("the duration hard limit auto-stops the recording", async () => {
  await withTempRoot(async (root) => {
    const audio = makeWavBuffer(loudSamples(4_000));
    const { spawnFn } = fakeRecorderSpawn({ audioOnStop: audio });
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
      tuning: { maxDurationMs: 20, maxBytes: 1024 * 1024, pollIntervalMs: 5, killGraceMs: 200 },
    });
    const handle = await recorder.start();
    const outcome = await handle.autoStopped;
    assert.equal(outcome.reason, "duration-limit");
    assert.ok(outcome.audio.sizeBytes > 44);
    await deleteRecordedAudio(outcome.audio);
  });
});

test("the size hard limit auto-stops the recording", async () => {
  await withTempRoot(async (root) => {
    const audio = makeWavBuffer(loudSamples(4_000));
    const { spawnFn } = fakeRecorderSpawn({ audioOnStop: audio, writeImmediately: true });
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
      tuning: { maxDurationMs: 60_000, maxBytes: 32, pollIntervalMs: 5, killGraceMs: 200 },
    });
    const handle = await recorder.start();
    const outcome = await handle.autoStopped;
    assert.equal(outcome.reason, "size-limit");
    await deleteRecordedAudio(outcome.audio);
  });
});

test("stop() after the limit already fired is rejected instead of double-finalizing", async () => {
  await withTempRoot(async (root) => {
    const audio = makeWavBuffer(loudSamples(4_000));
    const { spawnFn } = fakeRecorderSpawn({ audioOnStop: audio });
    const recorder = createProcessAudioRecorder({
      describe: "fake",
      isAvailable: async () => true,
      resolveCommand: async () => ({ executable: "fake-recorder", args: [] }),
      spawnFn,
      tempDir: root,
      tuning: { maxDurationMs: 15, maxBytes: 1024 * 1024, pollIntervalMs: 5, killGraceMs: 200 },
    });
    const handle = await recorder.start();
    const outcome = await handle.autoStopped;
    await assert.rejects(handle.stop(), /bereits beendet/);
    await deleteRecordedAudio(outcome.audio);
  });
});

test("ensureSwiftRecorderCommand compiles once and reuses the cached binary", async () => {
  const files = new Set<string>();
  let compileCalls = 0;
  const deps = {
    appHome: "/fake/home/.routercode",
    fileExists: async (path: string) => files.has(path),
    makeSecureDir: async () => {},
    writeSource: async (path: string) => {
      files.add(path);
    },
    compile: async ({ outputPath }: { outputPath: string }) => {
      compileCalls += 1;
      files.add(outputPath);
      return { code: 0, stderr: "" };
    },
    chmod: async () => {},
    checkCommand: async () => true,
  };
  const first = await ensureSwiftRecorderCommand(deps);
  const second = await ensureSwiftRecorderCommand(deps);
  assert.equal(compileCalls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.executable, swiftBinaryPath(deps.appHome));
  assert.deepEqual(first.args, []);
});

test("ensureSwiftRecorderCommand falls back to the swift interpreter when swiftc fails", async () => {
  const deps = {
    appHome: "/fake/home/.routercode",
    fileExists: async () => false,
    makeSecureDir: async () => {},
    writeSource: async () => {},
    compile: async () => ({ code: 1, stderr: "swiftc: command not found" }),
    chmod: async () => {},
    checkCommand: async (command: string) => command === "swift",
  };
  const result = await ensureSwiftRecorderCommand(deps);
  assert.equal(result.executable, "swift");
  assert.equal(result.args.length, 1);
});

test("ensureSwiftRecorderCommand gives a clear German error when nothing works", async () => {
  const deps = {
    appHome: "/fake/home/.routercode",
    fileExists: async () => false,
    makeSecureDir: async () => {},
    writeSource: async () => {},
    compile: async () => ({ code: 1, stderr: "no compiler" }),
    chmod: async () => {},
    checkCommand: async () => false,
  };
  await assert.rejects(ensureSwiftRecorderCommand(deps), /Swift-Aufnahmeprogramm/);
});

test("createAudioRecorders on darwin tries Swift before ffmpeg", async () => {
  const providers = createAudioRecorders({
    platform: "darwin",
    appHome: "/fake/home/.routercode",
    checkCommand: async () => false,
    fileExists: async () => false,
    makeSecureDir: async () => {},
    writeSource: async () => {},
    chmod: async () => {},
    spawnFn: () => new FakeChildProcess(),
  });
  assert.deepEqual(
    providers.map((provider) => provider.describe()),
    ["Swift/AVFoundation (macOS)", "ffmpeg (darwin)"],
  );
});

test("createAudioRecorders on linux offers ffmpeg, arecord and parecord", async () => {
  const providers = createAudioRecorders({
    platform: "linux",
    appHome: "/fake/home/.routercode",
    checkCommand: async () => false,
    fileExists: async () => false,
    makeSecureDir: async () => {},
    writeSource: async () => {},
    chmod: async () => {},
    spawnFn: () => new FakeChildProcess(),
  });
  assert.deepEqual(
    providers.map((provider) => provider.describe()),
    ["ffmpeg (linux)", "arecord (alsa-utils)", "parecord (pulseaudio-utils)"],
  );
});

test("createAudioRecorders on win32 only offers ffmpeg", async () => {
  const providers = createAudioRecorders({
    platform: "win32",
    appHome: "/fake/home/.routercode",
    checkCommand: async () => false,
    fileExists: async () => false,
    makeSecureDir: async () => {},
    writeSource: async () => {},
    chmod: async () => {},
    spawnFn: () => new FakeChildProcess(),
  });
  assert.deepEqual(providers.map((provider) => provider.describe()), ["ffmpeg (win32)"]);
});

test("selectAudioRecorder picks the first available provider and skips the rest", async () => {
  const calls: string[] = [];
  const unavailable = createFfmpegAudioRecorder({
    platform: "linux",
    checkCommand: async () => {
      calls.push("ffmpeg");
      return false;
    },
    spawnFn: () => new FakeChildProcess(),
  });
  const available = createArecordAudioRecorder({
    checkCommand: async () => {
      calls.push("arecord");
      return true;
    },
    spawnFn: () => new FakeChildProcess(),
  });
  const neverChecked = createParecordAudioRecorder({
    checkCommand: async () => {
      calls.push("parecord");
      return true;
    },
    spawnFn: () => new FakeChildProcess(),
  });
  const selected = await selectAudioRecorder([unavailable, available, neverChecked]);
  assert.equal(selected.describe(), "arecord (alsa-utils)");
  assert.deepEqual(calls, ["ffmpeg", "arecord"]);
});

test("selectAudioRecorder throws a German error listing what was checked and a platform install hint", async () => {
  const providers = [
    createFfmpegAudioRecorder({ platform: "linux", checkCommand: async () => false, spawnFn: () => new FakeChildProcess() }),
    createArecordAudioRecorder({ checkCommand: async () => false, spawnFn: () => new FakeChildProcess() }),
  ];
  await assert.rejects(selectAudioRecorder(providers, "linux"), (error: unknown) => {
    assert.ok(error instanceof NoAudioRecorderAvailableError);
    assert.match(error.message, /ffmpeg \(linux\)/);
    assert.match(error.message, /arecord \(alsa-utils\)/);
    assert.match(error.message, /sudo apt install ffmpeg/);
    return true;
  });
});

test("selectAudioRecorder suggests brew on darwin and winget on win32", async () => {
  await assert.rejects(selectAudioRecorder([], "darwin"), /brew install ffmpeg/);
  await assert.rejects(selectAudioRecorder([], "win32"), /winget install ffmpeg/);
});

test("the Windows ffmpeg provider is only available once a dshow audio device is found", async () => {
  const withDevice = createFfmpegAudioRecorder({
    platform: "win32",
    checkCommand: async () => true,
    spawnFn: () => new FakeChildProcess(),
    listWindowsAudioDevices: async () => '[dshow @ 0000] "Microphone (Realtek Audio)" (audio)',
  });
  assert.equal(await withDevice.isAvailable(), true);

  const withoutDevice = createFfmpegAudioRecorder({
    platform: "win32",
    checkCommand: async () => true,
    spawnFn: () => new FakeChildProcess(),
    listWindowsAudioDevices: async () => "[dshow @ 0000] no devices found",
  });
  assert.equal(await withoutDevice.isAvailable(), false);
});

test("consent is asked once before the first recording and never again", async () => {
  const config = { voiceConsentGiven: false };
  let askCalls = 0;
  let persistCalls = 0;
  const ask = async () => {
    askCalls += 1;
    return true;
  };
  const persist = async () => {
    persistCalls += 1;
  };

  const first = await ensureVoiceConsent(config, ask, persist);
  assert.equal(first, true);
  assert.equal(askCalls, 1);
  assert.equal(persistCalls, 1);
  assert.equal(config.voiceConsentGiven, true);

  const second = await ensureVoiceConsent(config, ask, persist);
  assert.equal(second, true);
  assert.equal(askCalls, 1, "consent must not be asked again once granted");
  assert.equal(persistCalls, 1);
});

test("declining consent leaves the flag unset and asks again next time", async () => {
  const config = { voiceConsentGiven: false };
  let askCalls = 0;
  const ask = async () => {
    askCalls += 1;
    return false;
  };
  const persist = async () => {
    throw new Error("must not persist a declined consent");
  };

  const result = await ensureVoiceConsent(config, ask, persist);
  assert.equal(result, false);
  assert.equal(config.voiceConsentGiven, false);
  assert.equal(askCalls, 1);

  await ensureVoiceConsent(config, ask, persist);
  assert.equal(askCalls, 2, "declining must ask again on the next recording");
});
