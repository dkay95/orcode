/**
 * Microphone recording (`/whisper`, `/voice`).
 *
 * Recording is provider-based so orcode is not tied to macOS/Swift: each
 * `AudioRecorder` knows how to check its own availability and how to start a
 * recording; `selectAudioRecorder` tries them in order and uses the first one
 * that is actually usable on this machine. Every provider shares one control
 * loop (`createProcessAudioRecorder`) — spawn detached (own process group,
 * same discipline as `runProcess` in workspace.ts), stop via SIGINT (the
 * tools we use all finalize their output file gracefully on SIGINT),
 * cancel via SIGTERM, escalate to SIGKILL if the process ignores it.
 *
 * Every external dependency (platform, PATH lookups, process spawning,
 * filesystem, Swift compilation) is injectable so the provider-selection and
 * limit-enforcement logic can be unit tested without a real microphone, a
 * real Swift/ffmpeg/arecord binary, or touching the real `~/.orcode`.
 */

import { spawn } from "node:child_process";
import { chmod as chmodFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_HOME, ensureSecureDirectory } from "./config.js";
import { sanitizedEnvironment } from "./workspace.js";
import { errorMessage, truncate } from "./utils.js";

/** Hard cap: a recording longer than this is stopped automatically (B/2). */
export const RECORDING_MAX_DURATION_MS = 120_000;
/** Hard cap: a recording larger than this is stopped automatically (B/2). */
export const RECORDING_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_KILL_GRACE_MS = 1_500;
/** Below this peak amplitude (0..1 of full scale) a recording is flagged as quiet, not rejected. */
const QUIET_PEAK_THRESHOLD = 0.03;
/** Below this many milliseconds of decoded audio a recording is rejected as empty. */
const MIN_USABLE_DURATION_MS = 200;

export const SWIFT_BINARY_NAME = "orcode-record";

export type AudioFormat = "wav";

export interface RecordedAudio {
  /** Absolute path to the temp WAV file. Caller deletes it via `deleteRecordedAudio`. */
  path: string;
  format: AudioFormat;
  sizeBytes: number;
  durationMs: number;
  /** Heuristic only — a low peak amplitude. Never blocks; the caller decides whether to warn. */
  quiet: boolean;
}

export type RecordingStopReason = "duration-limit" | "size-limit";

export interface RecordingHandle {
  readonly startedAt: number;
  /** Signals a graceful stop and returns the finalized recording. Throws a German error if the file is unusable. */
  stop(): Promise<RecordedAudio>;
  /** Aborts the recording and deletes any partial file. Never throws. */
  cancel(): Promise<void>;
  /**
   * Resolves exactly once, only when a hard limit (duration or size) forced
   * the recording to stop before `stop()`/`cancel()` was called. Stays
   * pending forever otherwise — never rejects.
   */
  readonly autoStopped: Promise<{ reason: RecordingStopReason; audio: RecordedAudio }>;
}

export interface AudioRecorder {
  isAvailable(): Promise<boolean>;
  /** Short, human-readable description of what this provider uses — shown in error messages. */
  describe(): string;
  start(): Promise<RecordingHandle>;
}

export class NoAudioRecorderAvailableError extends Error {
  constructor(
    public readonly checked: readonly string[],
    public readonly platform: NodeJS.Platform,
  ) {
    super(buildNoRecorderMessage(checked, platform));
    this.name = "NoAudioRecorderAvailableError";
  }
}

function buildNoRecorderMessage(checked: readonly string[], platform: NodeJS.Platform): string {
  const tried = checked.length
    ? `Geprüft: ${checked.join(", ")}.`
    : "Es stand kein Aufnahmeweg zur Auswahl.";
  const hint =
    platform === "darwin"
      ? "Installiere ffmpeg mit: brew install ffmpeg"
      : platform === "linux"
        ? "Installiere ffmpeg mit: sudo apt install ffmpeg (Alternative: alsa-utils oder pulseaudio-utils für arecord/parecord)"
        : platform === "win32"
          ? "Installiere ffmpeg mit: winget install ffmpeg"
          : "Installiere ffmpeg für dieses System.";
  return `Kein Weg gefunden, das Mikrofon aufzunehmen. ${tried} ${hint}`;
}

/** Tries every provider in order; the first one that reports itself available wins. */
export async function selectAudioRecorder(
  providers: readonly AudioRecorder[],
  platform: NodeJS.Platform = process.platform,
): Promise<AudioRecorder> {
  const checked: string[] = [];
  for (const provider of providers) {
    checked.push(provider.describe());
    let available: boolean;
    try {
      available = await provider.isAvailable();
    } catch {
      available = false;
    }
    if (available) {
      return provider;
    }
  }
  throw new NoAudioRecorderAvailableError(checked, platform);
}

/** Deletes the recording's temp directory. Never throws — always safe to call, including twice. */
export async function deleteRecordedAudio(audio: RecordedAudio): Promise<void> {
  await rm(dirname(audio.path), { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Process control shared by every provider
// ---------------------------------------------------------------------------

/** Minimal shape voice.ts needs from a spawned child process — matches `child_process.ChildProcess` structurally. */
export interface RecorderProcess {
  readonly pid?: number;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void } | null;
}

export type SpawnFn = (executable: string, args: readonly string[]) => RecorderProcess;

const defaultSpawn: SpawnFn = (executable, args) =>
  spawn(executable, [...args], {
    env: sanitizedEnvironment(),
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });

function signalProcess(child: RecorderProcess, signalName: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signalName);
  } catch {
    try {
      child.kill(signalName);
    } catch {
      // The process is already gone.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface RecorderTuning {
  maxDurationMs: number;
  maxBytes: number;
  pollIntervalMs: number;
  killGraceMs: number;
}

const DEFAULT_TUNING: RecorderTuning = {
  maxDurationMs: RECORDING_MAX_DURATION_MS,
  maxBytes: RECORDING_MAX_BYTES,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  killGraceMs: DEFAULT_KILL_GRACE_MS,
};

export interface ProcessRecorderOptions {
  describe: string;
  isAvailable: () => Promise<boolean>;
  /** Builds the command for a fresh recording, given the output WAV path. */
  resolveCommand: (outputPath: string) => Promise<{ executable: string; args: string[] }>;
  spawnFn?: SpawnFn;
  tempDir?: string;
  tuning?: Partial<RecorderTuning>;
}

/** Every concrete provider (Swift, ffmpeg, arecord, parecord) is this same control loop with a different command. */
export function createProcessAudioRecorder(options: ProcessRecorderOptions): AudioRecorder {
  return {
    describe: () => options.describe,
    isAvailable: () => options.isAvailable(),
    start: () => startProcessRecording(options),
  };
}

async function startProcessRecording(options: ProcessRecorderOptions): Promise<RecordingHandle> {
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const tuning: RecorderTuning = { ...DEFAULT_TUNING, ...options.tuning };
  const root = options.tempDir ?? tmpdir();
  const dir = await mkdtemp(join(root, "orcode-voice-"));
  const outputPath = join(dir, "aufnahme.wav");
  const { executable, args } = await options.resolveCommand(outputPath);

  let child: RecorderProcess;
  try {
    child = spawnFn(executable, [...args, outputPath]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Aufnahmeprozess (${executable}) konnte nicht gestartet werden: ${errorMessage(error)}`,
    );
  }

  let stderrText = "";
  child.stderr?.on("data", (chunk) => {
    stderrText = truncate(stderrText + chunk.toString(), 4_000);
  });

  let settled = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", () => {
      settled = true;
      resolve();
    });
    child.on("error", () => {
      settled = true;
      resolve();
    });
  });

  const startedAt = Date.now();

  /** Signals the child, waits for it to exit (escalating to SIGKILL after a grace period), then finalizes or discards the file. */
  const finalize = async (
    signalName: NodeJS.Signals,
    deleteFile: boolean,
  ): Promise<RecordedAudio | null> => {
    signalProcess(child, signalName);
    if (!settled) {
      await Promise.race([exitPromise, delay(tuning.killGraceMs)]);
      if (!settled) {
        signalProcess(child, "SIGKILL");
        await Promise.race([exitPromise, delay(500)]);
      }
    }
    if (deleteFile) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    try {
      return await finalizeRecording(outputPath, startedAt);
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw translateRecorderFailure(error, stderrText);
    }
  };

  // `phase` is only ever advanced synchronously (no `await` between the check
  // and the write), so a race between the limit monitor and an explicit
  // stop()/cancel() call can never double-claim the recording.
  let phase: "recording" | "settling" | "done" = "recording";
  let autoStoppedResolve!: (value: { reason: RecordingStopReason; audio: RecordedAudio }) => void;
  const autoStopped = new Promise<{ reason: RecordingStopReason; audio: RecordedAudio }>((resolve) => {
    autoStoppedResolve = resolve;
  });

  const monitor = setInterval(() => {
    if (phase !== "recording") {
      return;
    }
    void (async () => {
      const elapsedMs = Date.now() - startedAt;
      let sizeBytes = 0;
      try {
        sizeBytes = (await stat(outputPath)).size;
      } catch {
        sizeBytes = 0;
      }
      const reason: RecordingStopReason | null =
        elapsedMs >= tuning.maxDurationMs
          ? "duration-limit"
          : sizeBytes >= tuning.maxBytes
            ? "size-limit"
            : null;
      if (!reason || (phase as string) !== "recording") {
        return;
      }
      phase = "settling";
      clearInterval(monitor);
      try {
        const audio = await finalize("SIGINT", false);
        phase = "done";
        if (audio) {
          autoStoppedResolve({ reason, audio });
        }
      } catch {
        phase = "done";
        // No listener is required to observe a failed automatic stop; the
        // caller's own stop()/cancel() call (if it still makes one) will
        // surface the failure through its own rejection.
      }
    })();
  }, tuning.pollIntervalMs);
  // Deliberately not `unref()`'d: this timer is the only thing that can ever
  // resolve `autoStopped`, so it must be able to keep the process alive for
  // as long as a recording is in progress. `stop()`/`cancel()` and the
  // monitor's own limit branch both `clearInterval` it, so it never lingers
  // once the recording has ended.

  return {
    startedAt,
    autoStopped,
    async stop(): Promise<RecordedAudio> {
      if (phase !== "recording") {
        throw new Error("Die Aufnahme wurde bereits beendet.");
      }
      phase = "settling";
      clearInterval(monitor);
      const audio = await finalize("SIGINT", false);
      phase = "done";
      if (!audio) {
        throw new Error("Aufnahme konnte nicht gespeichert werden.");
      }
      return audio;
    },
    async cancel(): Promise<void> {
      if (phase !== "recording") {
        return;
      }
      phase = "settling";
      clearInterval(monitor);
      await finalize("SIGTERM", true);
      phase = "done";
    },
  };
}

const MICROPHONE_PERMISSION_HINT =
  "Kein Zugriff aufs Mikrofon. Erteile orcode die Berechtigung unter " +
  "Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon, und versuche es erneut.";

const NO_MICROPHONE_HINT =
  "Es wurde kein Mikrofon gefunden. Schließe ein Mikrofon an (oder aktiviere das eingebaute) und versuche es erneut.";

/**
 * Enriches a generic "file was never created" failure with what the
 * recorder actually reported on stderr — most importantly the Swift
 * program's `ORCODE_ERROR:PERMISSION_DENIED` and
 * `ORCODE_ERROR:RECORDER_INIT_FAILED` markers, which become specific,
 * actionable German messages instead of a bare "no file" error.
 */
function translateRecorderFailure(error: unknown, stderrText: string): Error {
  if (stderrText.includes("ORCODE_ERROR:PERMISSION_DENIED")) {
    return new Error(MICROPHONE_PERMISSION_HINT);
  }
  if (stderrText.includes("ORCODE_ERROR:RECORDER_INIT_FAILED")) {
    return new Error(NO_MICROPHONE_HINT);
  }
  const base = error instanceof Error ? error.message : errorMessage(error);
  if (stderrText.includes("ORCODE_ERROR:")) {
    return new Error(`Aufnahmeprogramm konnte nicht starten: ${truncate(stderrText.trim(), 400)}`);
  }
  if (stderrText.trim() && /nicht erzeugt/.test(base)) {
    return new Error(`${base} (${truncate(stderrText.trim(), 400)})`);
  }
  return error instanceof Error ? error : new Error(base);
}

async function finalizeRecording(outputPath: string, startedAt: number): Promise<RecordedAudio> {
  let info;
  try {
    info = await stat(outputPath);
  } catch (error) {
    throw new Error(`Aufnahmedatei wurde nicht erzeugt: ${errorMessage(error)}`);
  }
  if (info.size <= 44) {
    // A bare WAV header (44 bytes) with no sample data at all.
    throw new Error(
      "Die Aufnahme ist leer. Bitte sprich, bevor du die Aufnahme stoppst, und versuche es erneut.",
    );
  }
  const buffer = await readFile(outputPath);
  const wav = analyzeWav(buffer);
  if (wav.sampleCount === 0 || wav.durationMs < MIN_USABLE_DURATION_MS) {
    throw new Error(
      "Die Aufnahme ist leer oder zu kurz. Bitte sprich, bevor du die Aufnahme stoppst, und versuche es erneut.",
    );
  }
  return {
    path: outputPath,
    format: "wav",
    sizeBytes: info.size,
    durationMs: wav.durationMs || Date.now() - startedAt,
    quiet: wav.peakAmplitude < QUIET_PEAK_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// Minimal WAV (RIFF/PCM16) analysis — no external dependency
// ---------------------------------------------------------------------------

interface WavInfo {
  sampleCount: number;
  peakAmplitude: number;
  durationMs: number;
}

export function analyzeWav(buffer: Buffer): WavInfo {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return { sampleCount: 0, peakAmplitude: 0, durationMs: 0 };
  }
  let offset = 12;
  let sampleRate = 16_000;
  let bitsPerSample = 16;
  let channels = 1;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === "fmt " && bodyStart + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(bodyStart + 2) || 1;
      sampleRate = buffer.readUInt32LE(bodyStart + 4) || 16_000;
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14) || 16;
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      dataLength = Math.max(0, Math.min(chunkSize, buffer.length - bodyStart));
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  if (dataStart < 0 || dataLength <= 0 || bitsPerSample !== 16) {
    return { sampleCount: 0, peakAmplitude: 0, durationMs: 0 };
  }
  const sampleCount = Math.floor(dataLength / 2);
  let peak = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.abs(buffer.readInt16LE(dataStart + index * 2));
    if (value > peak) {
      peak = value;
    }
  }
  const frames = channels > 0 ? sampleCount / channels : sampleCount;
  const durationMs = sampleRate > 0 ? (frames / sampleRate) * 1000 : 0;
  return { sampleCount, peakAmplitude: peak / 32_768, durationMs };
}

// ---------------------------------------------------------------------------
// Availability checks
// ---------------------------------------------------------------------------

export type CheckCommand = (command: string) => Promise<boolean>;

/** Real default for `CheckCommand`: is `command` on PATH? Uses `which`/`where`, never runs the tool itself. */
export function commandOnPath(
  command: string,
  spawnFn: SpawnFn = defaultSpawn,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const finder = platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    let child: RecorderProcess;
    try {
      child = spawnFn(finder, [command]);
    } catch {
      resolve(false);
      return;
    }
    let done = false;
    child.on("exit", (code) => {
      if (!done) {
        done = true;
        resolve(code === 0);
      }
    });
    child.on("error", () => {
      if (!done) {
        done = true;
        resolve(false);
      }
    });
  });
}

/** Runs a process to completion and captures combined stdout+stderr text — used for `swiftc` and ffmpeg's `-list_devices`. */
function runToCompletion(
  spawnFn: SpawnFn,
  executable: string,
  args: readonly string[],
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let child: RecorderProcess;
    try {
      child = spawnFn(executable, args);
    } catch (error) {
      resolve({ code: null, output: errorMessage(error) });
      return;
    }
    let output = "";
    child.stderr?.on("data", (chunk) => {
      output = truncate(output + chunk.toString(), 8_000);
    });
    child.on("exit", (code) => resolve({ code, output }));
    child.on("error", (error) => resolve({ code: null, output: errorMessage(error) }));
  });
}

// ---------------------------------------------------------------------------
// macOS: Swift/AVFoundation, compiled once and cached under ~/.orcode/bin
// ---------------------------------------------------------------------------

/**
 * 16 kHz mono PCM16 WAV, controlled entirely by signals: SIGINT stops and
 * keeps the file, SIGTERM stops and deletes it. `record(forDuration:)` is a
 * second, native safety net for the 120s hard cap in case the Node-side timer
 * never gets to signal the process at all.
 */
export const SWIFT_RECORDER_SOURCE = `import AVFoundation
import Foundation

let commandLineArguments = CommandLine.arguments
guard commandLineArguments.count > 1 else {
    FileHandle.standardError.write("ORCODE_ERROR:USAGE Kein Ausgabepfad angegeben.\\n".data(using: .utf8)!)
    exit(64)
}
let outputURL = URL(fileURLWithPath: commandLineArguments[1])

let permissionSemaphore = DispatchSemaphore(value: 0)
var microphoneGranted = false
AVCaptureDevice.requestAccess(for: .audio) { granted in
    microphoneGranted = granted
    permissionSemaphore.signal()
}
permissionSemaphore.wait()
guard microphoneGranted else {
    FileHandle.standardError.write("ORCODE_ERROR:PERMISSION_DENIED\\n".data(using: .utf8)!)
    exit(2)
}

let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVSampleRateKey: 16_000,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
]

final class RecorderDelegate: NSObject, AVAudioRecorderDelegate {
    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        exit(flag ? 0 : 1)
    }
}
let delegate = RecorderDelegate()

guard let recorder = try? AVAudioRecorder(url: outputURL, settings: settings) else {
    FileHandle.standardError.write("ORCODE_ERROR:RECORDER_INIT_FAILED\\n".data(using: .utf8)!)
    exit(3)
}
recorder.delegate = delegate

guard recorder.record(forDuration: 120) else {
    FileHandle.standardError.write("ORCODE_ERROR:RECORD_START_FAILED\\n".data(using: .utf8)!)
    exit(4)
}

func stopAndExit(deleteFile: Bool) {
    recorder.stop()
    if deleteFile {
        recorder.deleteRecording()
    }
    exit(0)
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigintSource.setEventHandler { stopAndExit(deleteFile: false) }
sigintSource.resume()
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSource.setEventHandler { stopAndExit(deleteFile: true) }
sigtermSource.resume()

RunLoop.main.run()
`;

export interface SwiftCompileDeps {
  appHome: string;
  fileExists: (path: string) => Promise<boolean>;
  makeSecureDir: (path: string) => Promise<void>;
  writeSource: (path: string, content: string) => Promise<void>;
  compile: (args: { sourcePath: string; outputPath: string }) => Promise<{ code: number | null; stderr: string }>;
  chmod: (path: string, mode: number) => Promise<void>;
  checkCommand: CheckCommand;
}

export function swiftBinaryPath(appHome: string): string {
  return join(appHome, "bin", SWIFT_BINARY_NAME);
}

/**
 * Compiles the embedded Swift source once and caches the binary at
 * `~/.orcode/bin/orcode-record` (both 0700). Subsequent calls find
 * the cached binary and skip compilation entirely. If `swiftc` fails, falls
 * back to `swift <source-file>` (interpreted, no caching possible). If
 * neither works, throws a clear German error explaining why.
 */
export async function ensureSwiftRecorderCommand(
  deps: SwiftCompileDeps,
): Promise<{ executable: string; args: string[] }> {
  const binaryPath = swiftBinaryPath(deps.appHome);
  if (await deps.fileExists(binaryPath)) {
    return { executable: binaryPath, args: [] };
  }
  const binDir = join(deps.appHome, "bin");
  await deps.makeSecureDir(binDir);
  const sourcePath = join(binDir, "orcode-record.swift");
  await deps.writeSource(sourcePath, SWIFT_RECORDER_SOURCE);

  let compiled: { code: number | null; stderr: string };
  try {
    compiled = await deps.compile({ sourcePath, outputPath: binaryPath });
  } catch (error) {
    compiled = { code: null, stderr: errorMessage(error) };
  }
  if (compiled.code === 0 && (await deps.fileExists(binaryPath))) {
    await deps.chmod(binaryPath, 0o700).catch(() => {});
    return { executable: binaryPath, args: [] };
  }

  if (await deps.checkCommand("swift")) {
    return { executable: "swift", args: [sourcePath] };
  }

  throw new Error(
    `Swift-Aufnahmeprogramm konnte nicht vorbereitet werden: weder "swiftc" (Kompilierung) noch "swift" (Interpreter) sind lauffähig.${
      compiled.stderr ? ` Details: ${truncate(compiled.stderr, 400)}` : ""
    } Prüfe, ob die Kommandozeilen-Tools installiert sind (xcode-select --install).`,
  );
}

export interface SwiftRecorderDependencies {
  appHome: string;
  checkCommand: CheckCommand;
  spawnFn: SpawnFn;
  tempDir?: string;
  tuning?: Partial<RecorderTuning>;
  /** Filesystem seams, real defaults filled in by `createAudioRecorders`. */
  fileExists: (path: string) => Promise<boolean>;
  makeSecureDir: (path: string) => Promise<void>;
  writeSource: (path: string, content: string) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
}

export function createSwiftAudioRecorder(deps: SwiftRecorderDependencies): AudioRecorder {
  return createProcessAudioRecorder({
    describe: "Swift/AVFoundation (macOS)",
    isAvailable: async () => {
      if (await deps.fileExists(swiftBinaryPath(deps.appHome))) {
        return true;
      }
      return (await deps.checkCommand("swiftc")) || (await deps.checkCommand("swift"));
    },
    resolveCommand: () =>
      ensureSwiftRecorderCommand({
        appHome: deps.appHome,
        fileExists: deps.fileExists,
        makeSecureDir: deps.makeSecureDir,
        writeSource: deps.writeSource,
        chmod: deps.chmod,
        checkCommand: deps.checkCommand,
        compile: ({ sourcePath, outputPath }) =>
          runToCompletion(deps.spawnFn, "swiftc", ["-O", sourcePath, "-o", outputPath]).then(
            ({ code, output }) => ({ code, stderr: output }),
          ),
      }),
    spawnFn: deps.spawnFn,
    tempDir: deps.tempDir,
    tuning: deps.tuning,
  });
}

// ---------------------------------------------------------------------------
// ffmpeg — all platforms, platform-specific input driver
// ---------------------------------------------------------------------------

export interface FfmpegRecorderDependencies {
  platform: NodeJS.Platform;
  checkCommand: CheckCommand;
  spawnFn: SpawnFn;
  tempDir?: string;
  tuning?: Partial<RecorderTuning>;
  /** Only consulted on win32; injectable so tests never spawn a real ffmpeg. */
  listWindowsAudioDevices?: () => Promise<string>;
}

async function resolveWindowsAudioDevice(deps: FfmpegRecorderDependencies): Promise<string | null> {
  const list =
    deps.listWindowsAudioDevices ??
    (async () => {
      const { output } = await runToCompletion(deps.spawnFn, "ffmpeg", [
        "-hide_banner",
        "-list_devices",
        "true",
        "-f",
        "dshow",
        "-i",
        "dummy",
      ]);
      return output;
    });
  let output: string;
  try {
    output = await list();
  } catch {
    return null;
  }
  const match = /"([^"]+)"\s*\(audio\)/i.exec(output);
  return match?.[1] ?? null;
}

/**
 * `outputPath` is intentionally unused: the shared control loop in
 * `startProcessRecording` appends it as the final argument for every
 * provider, right after `-f wav`, which is exactly where ffmpeg expects it.
 */
async function resolveFfmpegCommand(
  deps: FfmpegRecorderDependencies,
): Promise<{ executable: string; args: string[] }> {
  const durationSeconds = String(Math.ceil(RECORDING_MAX_DURATION_MS / 1_000));
  const tail = ["-ar", "16000", "-ac", "1", "-t", durationSeconds, "-f", "wav"];
  if (deps.platform === "darwin") {
    return { executable: "ffmpeg", args: ["-y", "-f", "avfoundation", "-i", ":0", ...tail] };
  }
  if (deps.platform === "linux") {
    return { executable: "ffmpeg", args: ["-y", "-f", "alsa", "-i", "default", ...tail] };
  }
  if (deps.platform === "win32") {
    const device = await resolveWindowsAudioDevice(deps);
    if (!device) {
      throw new Error("Kein Audiogerät für ffmpeg (dshow) unter Windows gefunden.");
    }
    return { executable: "ffmpeg", args: ["-y", "-f", "dshow", "-i", `audio=${device}`, ...tail] };
  }
  throw new Error(`ffmpeg-Aufnahme wird auf dieser Plattform nicht unterstützt: ${deps.platform}`);
}

export function createFfmpegAudioRecorder(deps: FfmpegRecorderDependencies): AudioRecorder {
  return createProcessAudioRecorder({
    describe: `ffmpeg (${deps.platform})`,
    isAvailable: async () => {
      if (!(await deps.checkCommand("ffmpeg"))) {
        return false;
      }
      if (deps.platform === "win32") {
        return (await resolveWindowsAudioDevice(deps)) !== null;
      }
      return deps.platform === "darwin" || deps.platform === "linux";
    },
    resolveCommand: () => resolveFfmpegCommand(deps),
    spawnFn: deps.spawnFn,
    tempDir: deps.tempDir,
    tuning: deps.tuning,
  });
}

// ---------------------------------------------------------------------------
// Linux: arecord (alsa-utils) / parecord (pulseaudio-utils)
// ---------------------------------------------------------------------------

export interface AlsaRecorderDependencies {
  checkCommand: CheckCommand;
  spawnFn: SpawnFn;
  tempDir?: string;
  tuning?: Partial<RecorderTuning>;
}

export function createArecordAudioRecorder(deps: AlsaRecorderDependencies): AudioRecorder {
  const durationSeconds = String(Math.ceil(RECORDING_MAX_DURATION_MS / 1_000));
  return createProcessAudioRecorder({
    describe: "arecord (alsa-utils)",
    isAvailable: () => deps.checkCommand("arecord"),
    resolveCommand: () =>
      Promise.resolve({
        executable: "arecord",
        args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", "-d", durationSeconds],
      }),
    spawnFn: deps.spawnFn,
    tempDir: deps.tempDir,
    tuning: deps.tuning,
  });
}

export function createParecordAudioRecorder(deps: AlsaRecorderDependencies): AudioRecorder {
  return createProcessAudioRecorder({
    describe: "parecord (pulseaudio-utils)",
    isAvailable: () => deps.checkCommand("parecord"),
    resolveCommand: () =>
      Promise.resolve({
        executable: "parecord",
        args: ["--file-format=wav", "--rate=16000", "--channels=1"],
      }),
    spawnFn: deps.spawnFn,
    tempDir: deps.tempDir,
    tuning: deps.tuning,
  });
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

export interface AudioRecorderDependencies {
  platform: NodeJS.Platform;
  appHome: string;
  checkCommand: CheckCommand;
  spawnFn: SpawnFn;
  tempDir?: string;
  tuning?: Partial<RecorderTuning>;
  fileExists: (path: string) => Promise<boolean>;
  makeSecureDir: (path: string) => Promise<void>;
  writeSource: (path: string, content: string) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  listWindowsAudioDevices?: () => Promise<string>;
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Real defaults for every seam, so `createAudioRecorders({})` works against the real machine. */
export function resolveAudioRecorderDependencies(
  overrides: Partial<AudioRecorderDependencies> = {},
): AudioRecorderDependencies {
  return {
    platform: process.platform,
    appHome: APP_HOME,
    checkCommand: (command) => commandOnPath(command, overrides.spawnFn ?? defaultSpawn, overrides.platform ?? process.platform),
    spawnFn: defaultSpawn,
    fileExists: defaultFileExists,
    makeSecureDir: ensureSecureDirectory,
    writeSource: (path, content) => writeFile(path, content, { encoding: "utf8", mode: 0o600 }),
    chmod: (path, mode) => chmodFile(path, mode),
    ...overrides,
  };
}

/** Builds the provider list for `deps.platform`, in the order they are tried. */
export function createAudioRecorders(overrides: Partial<AudioRecorderDependencies> = {}): AudioRecorder[] {
  const deps = resolveAudioRecorderDependencies(overrides);
  const providers: AudioRecorder[] = [];
  if (deps.platform === "darwin") {
    providers.push(createSwiftAudioRecorder(deps));
  }
  providers.push(createFfmpegAudioRecorder(deps));
  if (deps.platform === "linux") {
    providers.push(createArecordAudioRecorder(deps));
    providers.push(createParecordAudioRecorder(deps));
  }
  return providers;
}

// ---------------------------------------------------------------------------
// Consent gate (Bauplan: recording must never leave the machine unasked)
// ---------------------------------------------------------------------------

export interface VoiceConsentConfig {
  voiceConsentGiven: boolean;
}

/**
 * Asks for consent exactly once. `config.voiceConsentGiven` is mutated and
 * persisted in place so later calls with the same config object skip the
 * question. Returns whether recording may proceed.
 */
export async function ensureVoiceConsent(
  config: VoiceConsentConfig,
  askConsent: () => Promise<boolean>,
  persist: () => Promise<void>,
): Promise<boolean> {
  if (config.voiceConsentGiven) {
    return true;
  }
  const granted = await askConsent();
  if (granted) {
    config.voiceConsentGiven = true;
    await persist();
  }
  return granted;
}
