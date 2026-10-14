import type { ProcessResult } from "./workspace.js";

// References are connection-local opaque IDs, not serialized HANDLEs or recovery authority.
export type NativeRef = string;
export type NativePurpose = "project" | "app-home" | "work" | "scratch";
export type WinIdentity = Readonly<{ volumeSerialHex: string; fileId128Hex: string; kind: "file" | "directory" }>;
export type RootBinding = Readonly<{ ref: NativeRef; canonicalPath: string; identity: WinIdentity }>;
export type RunLease = Readonly<{ ref: NativeRef; runId: string; epoch: number; generation: string }>;
export type NativeFile = Readonly<{ path: string; bytes: Uint8Array; sha256: string;
  metadata: Readonly<{ kind: "windows"; attributes: number; securityDigest: string }> }>;
export type NativeEffect = Readonly<{ path: string; before: NativeFile | null; after: Uint8Array | null }>;
export type CanaryEvidence = Readonly<{ passed: boolean; osBuild: string; runtimeSha256: string;
  checks: Readonly<Record<string, boolean>> }>;
export type ToolSpec = Readonly<{ executableRef: NativeRef; argv: readonly string[]; cwdRef: NativeRef;
  env: Readonly<Record<string, string>>; timeoutMs: number }>;
export type NativeChunk = Readonly<{ stream: "stdout" | "stderr"; text: string }>;
export type PublishResult = Readonly<{ outcome: "applied" | "conflict" | "blocked-recovery"; journalRevision: number }>;

/** Implemented only by a native-authenticated private port; no browser/process.env factory. */
export interface NativePlatformPort {
  openNtfsRoot(path: string, purpose: NativePurpose): Promise<RootBinding>;
  createPrivateRun(homeRef: NativeRef, runId: string): Promise<{
    lease: RunLease; journalRef: NativeRef; work: RootBinding; scratch: RootBinding;
  }>;
  readPrivateJournal(journalRef: NativeRef, maxBytes: number): Promise<Uint8Array>;
  writePrivateJournal(journalRef: NativeRef, revision: number, bytes: Uint8Array): Promise<{ revision: number; sha256: string }>;
  snapshotTree(rootRef: NativeRef): Promise<readonly NativeFile[]>;
  copyWorkspace(sourceRef: NativeRef, destinationRef: NativeRef): Promise<void>;
  inspectExecutable(path: string): Promise<{ ref: NativeRef; sha256: string }>;
  prepareSandbox(lease: RunLease, binaries: readonly NativeRef[]): Promise<CanaryEvidence>;
  executeTool(lease: RunLease, spec: ToolSpec, signal: AbortSignal,
    onChunk: (chunk: NativeChunk) => void): Promise<ProcessResult>;
  retireRun(lease: RunLease): Promise<{ retiredEpoch: number }>;
  quiesceRun(lease: RunLease, drainMs: number): Promise<{ treeEmpty: boolean }>;
  publishExact(lease: RunLease, originalRef: NativeRef, candidateHash: string,
    effects: readonly NativeEffect[], journalRef: NativeRef): Promise<PublishResult>;
  close(): void;
}
