import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  consumeOneShotApprovalReceipt,
  isOneShotApprovalReceipt,
  type OneShotApprovalReceipt,
} from "./approval.js";
import { loadIgnore } from "./ignore.js";
import { classifyPath } from "./policy.js";
import { PrivateStore, type PrivateDirectoryClaim } from "./private-store.js";
import { requireOwnedLocalDirectory } from "./codex-profile.js";
import {
  ChangeJournal,
  WorkspaceGuard,
  type GuardedWorkspaceFileEffect,
} from "./workspace.js";

const MAX_STAGING_FILE_BYTES = 32 * 1_024 * 1_024;
const MAX_STAGING_TREE_BYTES = 512 * 1_024 * 1_024;
const MAX_STAGING_ENTRIES = 100_000;
const MAX_PATCH_DIFF_BYTES = 2 * 1_024 * 1_024;
const EMPTY_XATTR_DIGEST = createHash("sha256").update("").digest("hex");
const PRIVATE_TREE_SEGMENTS = new Set([".git", ".orcode", ".routercode", ".codex"]);
const STAGING_RUN_PATTERN = /^run-([0-9a-f]{32})$/;
const STAGING_OWNER_PATTERN = /^\.run-([0-9a-f]{32})\.owner\.json$/;
const MAX_RECLAIMED_RUNS = 64;

export type CodexPatchChangeKind = "add" | "update" | "delete";

export interface CodexPatchChange {
  readonly path: string;
  readonly kind: CodexPatchChangeKind;
  readonly diff: string;
}

export interface CodexPatchPreviewInput {
  readonly staging: CodexStagingWorkspace;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly childGeneration: number;
  readonly changes: readonly CodexPatchChange[];
}

export interface CodexPatchPreview {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly childGeneration: number;
  readonly changes: readonly CodexPatchChange[];
}

export interface CodexApprovedPatchPreview extends CodexPatchPreview {}

export interface CodexPatchApprovalBinding {
  readonly requestId: string;
  readonly previewDigest: string;
  readonly itemId: string;
  readonly paths: readonly string[];
  readonly epochDigest: string;
}

export interface CodexTreeSnapshotEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly size: number;
  readonly sha256: string | null;
  readonly modifiedAtNs: string;
}

export interface CodexTreeSnapshot {
  readonly entries: readonly CodexTreeSnapshotEntry[];
  readonly digest: string;
}

interface TreeDirectoryEntry {
  readonly path: string;
  readonly kind: "directory";
  readonly mode: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly modifiedAtNs: bigint;
  readonly xattrDigest: string;
}

interface TreeFileEntry {
  readonly path: string;
  readonly kind: "file";
  readonly mode: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly modifiedAtNs: bigint;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly xattrDigest: string;
  readonly xattrsOnlyProvenance: boolean;
}

type TreeEntry = TreeDirectoryEntry | TreeFileEntry;

interface InternalTreeSnapshot {
  readonly rootDevice: bigint;
  readonly rootInode: bigint;
  readonly rootMode: number;
  readonly rootXattrDigest: string;
  readonly entries: ReadonlyMap<string, TreeEntry>;
}

interface SourceFileEntry {
  readonly bytes: Buffer;
  readonly mode: number;
}

interface StagingState {
  readonly appHomeCanonical: string;
  readonly sourceWorkspaceCanonical: string;
  readonly store: PrivateStore;
  readonly claim: PrivateDirectoryClaim;
  readonly initial: InternalTreeSnapshot;
  readonly sourceFiles: ReadonlyMap<string, SourceFileEntry>;
  readonly ownerMarkerPath: string;
  readonly ownerMarkerContent: string;
  active: boolean;
}

interface PreviewEffect {
  readonly path: string;
  readonly kind: CodexPatchChangeKind;
  readonly before: Buffer | null;
  readonly after: Buffer | null;
  readonly sourceMode: number | null;
}

interface PreviewState {
  readonly staging: CodexStagingWorkspace;
  readonly effects: readonly PreviewEffect[];
}

interface PatchApprovalBindingState {
  readonly preview: CodexPatchPreview;
}

interface WorkspacePublicationAuthorityState {
  readonly workspace: WorkspaceGuard;
  readonly effects: readonly GuardedWorkspaceFileEffect[];
}

const STAGING_STATE = new WeakMap<CodexStagingWorkspace, StagingState>();
const PREVIEW_STATE = new WeakMap<object, PreviewState>();
const APPROVED_PREVIEWS = new WeakSet<object>();
const PATCH_APPROVAL_BINDINGS = new WeakMap<object, PatchApprovalBindingState>();
const ACTIVE_STAGING_RUNS = new Map<string, CodexStagingWorkspace>();
const WORKSPACE_PUBLICATION_AUTHORITIES = new WeakMap<object, WorkspacePublicationAuthorityState>();

export class CodexStagingWorkspace {
  private constructor(public readonly canonicalPath: string) {}

  static async create(input: Readonly<{
    appHome: string;
    realWorkspace: WorkspaceGuard;
  }>): Promise<CodexStagingWorkspace> {
    if (!(input.realWorkspace instanceof WorkspaceGuard)) {
      throw new Error("A verified real workspace is required for Codex staging.");
    }
    await input.realWorkspace.assertCurrent();
    const requestedAppHome = resolve(input.appHome);
    const ownedAppHome = await requireOwnedLocalDirectory(requestedAppHome, "Orcode app home");
    const prospectiveAppHome = await canonicalProspectivePath(requestedAppHome);
    assertDisjointTrees(prospectiveAppHome, input.realWorkspace.canonicalRoot);
    const appHomeInfo = await lstat(requestedAppHome, { bigint: true });
    const appHomeCanonical = await realpath(requestedAppHome);
    const canonicalAppHomeInfo = await lstat(appHomeCanonical, { bigint: true });
    if (appHomeInfo.isSymbolicLink() || !appHomeInfo.isDirectory()
      || canonicalAppHomeInfo.isSymbolicLink() || !canonicalAppHomeInfo.isDirectory()
      || appHomeInfo.dev !== canonicalAppHomeInfo.dev
      || appHomeInfo.ino !== canonicalAppHomeInfo.ino
      || appHomeCanonical !== prospectiveAppHome
      || appHomeCanonical !== ownedAppHome) {
      throw new Error("Codex staging requires a canonical real app home.");
    }
    assertDisjointTrees(appHomeCanonical, input.realWorkspace.canonicalRoot);

    const store = new PrivateStore({ root: appHomeCanonical });
    const stagingRoot = join(appHomeCanonical, "codex-staging");
    await store.ensureDirectory(stagingRoot);
    await reclaimStaleStagingRuns(stagingRoot, canonicalAppHomeInfo.dev);
    let runPath = "";
    let runClaim: PrivateDirectoryClaim | null = null;
    let ownerMarkerPath = "";
    let ownerMarkerContent = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = join(stagingRoot, `run-${randomBytes(16).toString("hex")}`);
      const claim = await store.createDirectoryExclusive(candidate);
      if (claim !== null) {
        await store.assertDirectoryClaim(claim);
        runPath = candidate;
        runClaim = claim;
        break;
      }
    }
    if (!runPath || runClaim === null) {
      throw new Error("Could not reserve a fresh Codex staging workspace.");
    }

    const runName = basename(runPath);
    const runMatch = STAGING_RUN_PATTERN.exec(runName);
    if (!runMatch) throw new Error("Codex staging run name is invalid.");
    ownerMarkerPath = join(stagingRoot, `.${runName}.owner.json`);
    ownerMarkerContent = JSON.stringify({
      version: 1,
      runName,
      nonce: runMatch[1],
      pid: process.pid,
      workspaceDigest: createHash("sha256")
        .update(input.realWorkspace.canonicalRoot)
        .digest("hex"),
    });
    await writeExclusiveFile(ownerMarkerPath, Buffer.from(ownerMarkerContent), 0o600);

    const runCanonical = await realpath(runPath);
    const runInfo = await lstat(runCanonical, { bigint: true });
    if (!isWithin(appHomeCanonical, runCanonical) || runInfo.isSymbolicLink()
      || !runInfo.isDirectory() || runInfo.dev !== canonicalAppHomeInfo.dev) {
      throw new Error("Codex staging run escaped the bound app home.");
    }
    const staging = new CodexStagingWorkspace(runCanonical);
    try {
      await store.assertDirectoryClaim(runClaim);
      const sourceFiles = await copyVerifiedWorkspace(
        input.realWorkspace.canonicalRoot,
        staging.canonicalPath,
        appHomeCanonical,
      );
      await input.realWorkspace.assertCurrent();
      await store.assertDirectoryClaim(runClaim);
      const initial = await scanTree(staging.canonicalPath, { requireOwnerOnly: true });
      await store.assertDirectoryClaim(runClaim);
      await input.realWorkspace.assertCurrent();
      STAGING_STATE.set(staging, {
        appHomeCanonical,
        sourceWorkspaceCanonical: input.realWorkspace.canonicalRoot,
        store,
        claim: runClaim,
        initial,
        sourceFiles,
        ownerMarkerPath,
        ownerMarkerContent,
        active: true,
      });
      ACTIVE_STAGING_RUNS.set(staging.canonicalPath, staging);
      return Object.freeze(staging);
    } catch (error) {
      await store.assertDirectoryClaim(runClaim)
        .then(() => removeExactStagingRun(staging.canonicalPath, runClaim, store))
        .catch(() => undefined);
      if (ownerMarkerPath) await unlink(ownerMarkerPath).catch(() => undefined);
      throw error;
    }
  }

  get active(): boolean {
    return requireStagingState(this).active;
  }

  async discard(): Promise<void> {
    const state = requireStagingState(this);
    if (!state.active) return;
    try {
      await state.store.assertDirectoryClaim(state.claim);
      await assertExactOwnerMarker(state.ownerMarkerPath, state.ownerMarkerContent);
      await removeExactStagingRun(this.canonicalPath, state.claim, state.store);
      await unlink(state.ownerMarkerPath);
    } finally {
      state.active = false;
      ACTIVE_STAGING_RUNS.delete(this.canonicalPath);
    }
  }
}

export async function createCodexStagingWorkspace(input: Readonly<{
  appHome: string;
  realWorkspace: WorkspaceGuard;
}>): Promise<CodexStagingWorkspace> {
  return CodexStagingWorkspace.create(input);
}

export async function createCodexPatchPreview(
  input: CodexPatchPreviewInput,
): Promise<CodexPatchPreview> {
  const stagingState = requireActiveStaging(input.staging);
  await stagingState.store.assertDirectoryClaim(stagingState.claim);
  assertSafeIdentifier(input.threadId, "thread id");
  assertSafeIdentifier(input.turnId, "turn id");
  assertSafeIdentifier(input.itemId, "item id");
  if (!Number.isSafeInteger(input.childGeneration) || input.childGeneration < 0) {
    throw new Error("Codex patch generation is invalid.");
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    throw new Error("Codex patch preview must contain at least one change.");
  }

  const seen = new Set<string>();
  const changes: CodexPatchChange[] = [];
  const effects: PreviewEffect[] = [];
  for (const raw of input.changes) {
    if (!isExactPatchChange(raw)) throw new Error("Codex patch change has an unknown schema.");
    const path = normalizeRelativePatchPath(raw.path);
    if (seen.has(path)) throw new Error(`Codex patch preview repeats a path: ${path}`);
    seen.add(path);
    if (Buffer.byteLength(raw.diff, "utf8") > MAX_PATCH_DIFF_BYTES || raw.diff.includes("\0")) {
      throw new Error(`Codex patch diff is invalid or too large: ${path}`);
    }
    const initial = stagingState.initial.entries.get(path);
    if (initial?.kind === "directory") {
      throw new Error(`Codex patch path is a directory: ${path}`);
    }
    const before = initial?.kind === "file" ? Buffer.from(initial.bytes) : null;
    if (raw.kind === "add" && before !== null) {
      throw new Error(`Codex add preview targets an existing file: ${path}`);
    }
    if ((raw.kind === "update" || raw.kind === "delete") && before === null) {
      throw new Error(`Codex ${raw.kind} preview targets a missing file: ${path}`);
    }
    const patched = applyUnifiedTextDiff(before ?? Buffer.alloc(0), raw.diff, path);
    if (raw.kind === "delete" && patched.byteLength !== 0) {
      throw new Error(`Codex delete preview does not remove the complete file: ${path}`);
    }
    if (raw.kind !== "delete" && patched.byteLength > MAX_STAGING_FILE_BYTES) {
      throw new Error(`Codex patch output is too large: ${path}`);
    }
    const frozenChange = Object.freeze({ path, kind: raw.kind, diff: raw.diff });
    changes.push(frozenChange);
    effects.push(Object.freeze({
      path,
      kind: raw.kind,
      before,
      after: raw.kind === "delete" ? null : patched,
      sourceMode: stagingState.sourceFiles.get(path)?.mode ?? null,
    }));
  }

  const preview = Object.freeze({
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: input.itemId,
    childGeneration: input.childGeneration,
    changes: Object.freeze(changes),
  });
  PREVIEW_STATE.set(preview, { staging: input.staging, effects: Object.freeze(effects) });
  await stagingState.store.assertDirectoryClaim(stagingState.claim);
  return preview;
}

/** Cryptographically and structurally binds one server request to one exact preview epoch. */
export function createCodexPatchApprovalBinding(
  preview: CodexPatchPreview,
  requestId: string,
): CodexPatchApprovalBinding {
  const state = requirePreviewState(preview);
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 8_192) {
    throw new Error("Codex patch approval request id is invalid.");
  }
  const paths = Object.freeze(state.effects.map((effect) => effect.path).sort());
  const effectClaims = state.effects
    .map((effect) => ({
      path: effect.path,
      kind: effect.kind,
      before: effect.before === null ? null : createHash("sha256").update(effect.before).digest("hex"),
      after: effect.after === null ? null : createHash("sha256").update(effect.after).digest("hex"),
      sourceMode: effect.sourceMode,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const epochDigest = createHash("sha256").update(JSON.stringify({
    staging: state.staging.canonicalPath,
    threadId: preview.threadId,
    turnId: preview.turnId,
    childGeneration: preview.childGeneration,
  })).digest("hex");
  const previewDigest = createHash("sha256").update(JSON.stringify({
    requestId,
    epochDigest,
    itemId: preview.itemId,
    paths,
    effects: effectClaims,
  })).digest("hex");
  const binding = Object.freeze({
    requestId,
    previewDigest,
    itemId: preview.itemId,
    paths,
    epochDigest,
  });
  PATCH_APPROVAL_BINDINGS.set(binding, { preview });
  return binding;
}

export function approveCodexPatchPreview(
  preview: CodexPatchPreview,
  receipt: OneShotApprovalReceipt,
  binding: CodexPatchApprovalBinding,
): CodexApprovedPatchPreview {
  if (!PREVIEW_STATE.has(preview as object)) throw new Error("Codex patch preview is not authentic.");
  const bindingState = PATCH_APPROVAL_BINDINGS.get(binding as object);
  if (!isOneShotApprovalReceipt(receipt) || receipt.decision !== "accept"
    || receipt.request.name !== "codex_file_change" || receipt.request.risk !== "edit"
    || receipt.request.rememberable !== false
    || bindingState?.preview !== preview
    || receipt.authorityBinding !== binding
    || !consumeOneShotApprovalReceipt(receipt)) {
    throw new Error("Codex patch preview lacks exact bound one-shot owner approval.");
  }
  APPROVED_PREVIEWS.add(preview as object);
  return preview as CodexApprovedPatchPreview;
}

export async function assertCodexPatchPreviewCurrent(preview: CodexPatchPreview): Promise<void> {
  const state = requirePreviewState(preview);
  const staging = requireActiveStaging(state.staging);
  await staging.store.assertDirectoryClaim(staging.claim);
  const current = await scanTree(state.staging.canonicalPath, { requireOwnerOnly: false });
  await staging.store.assertDirectoryClaim(staging.claim);
  assertSameStagingRoot(staging.initial, current);
  for (const effect of state.effects) {
    const initial = staging.initial.entries.get(effect.path);
    const actual = current.entries.get(effect.path);
    if (!sameTreeEntry(initial, actual)) {
      throw new Error(`Codex patch preview is stale or link-swapped: ${effect.path}`);
    }
  }
}

export async function publishExactStagedEffects(input: Readonly<{
  staging: CodexStagingWorkspace;
  previews: readonly CodexApprovedPatchPreview[];
  realWorkspace: WorkspaceGuard;
  journal: ChangeJournal;
  runId: string;
}>): Promise<Readonly<{ publishedPaths: readonly string[] }>> {
  const stagingState = requireActiveStaging(input.staging);
  if (!(input.realWorkspace instanceof WorkspaceGuard)
    || input.realWorkspace.canonicalRoot !== stagingState.sourceWorkspaceCanonical) {
    await input.staging.discard();
    throw new Error("Codex staging is not bound to this verified real workspace.");
  }
  if (!(input.journal instanceof ChangeJournal)) {
    await input.staging.discard();
    throw new Error("Codex publication requires the existing change journal.");
  }

  try {
    if (!Array.isArray(input.previews)) throw new Error("Codex approved previews are invalid.");
    const effectByPath = new Map<string, PreviewEffect>();
    const itemIds = new Set<string>();
    for (const preview of input.previews) {
      const previewState = requirePreviewState(preview);
      if (!APPROVED_PREVIEWS.has(preview as object)
        || previewState.staging !== input.staging) {
        throw new Error("Codex patch preview is not approved for this staging workspace.");
      }
      if (itemIds.has(preview.itemId)) throw new Error("Codex patch preview item is duplicated.");
      itemIds.add(preview.itemId);
      for (const effect of previewState.effects) {
        if (effectByPath.has(effect.path)) {
          throw new Error(`Codex approved previews overlap: ${effect.path}`);
        }
        effectByPath.set(effect.path, effect);
      }
    }

    await stagingState.store.assertDirectoryClaim(stagingState.claim);
    const current = await scanTree(input.staging.canonicalPath, { requireOwnerOnly: false });
    await stagingState.store.assertDirectoryClaim(stagingState.claim);
    assertExactStagingEffects(stagingState.initial, current, effectByPath);
    if (effectByPath.size === 0) {
      return Object.freeze({ publishedPaths: Object.freeze([]) });
    }

    const effects = [...effectByPath.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((effect) => {
        const currentEntry = current.entries.get(effect.path);
        return {
          path: effect.path,
          before: effect.before,
          after: effect.after,
          ...(effect.sourceMode === null ? {} : { beforeMode: effect.sourceMode }),
          createdMode: currentEntry?.kind === "file" && (currentEntry.mode & 0o100) !== 0
            ? 0o700
            : 0o600,
        };
      });
    const authority = Object.freeze({});
    WORKSPACE_PUBLICATION_AUTHORITIES.set(authority, {
      workspace: input.realWorkspace,
      effects: Object.freeze(effects),
    });
    return await input.realWorkspace.publishCodexApprovedEffects(
      authority,
      input.journal,
      input.runId,
    );
  } finally {
    await input.staging.discard();
  }
}

/** @internal Consumed only by WorkspaceGuard's non-bypassable publication method. */
export function consumeCodexWorkspacePublicationAuthority(
  authority: object,
  workspace: WorkspaceGuard,
): readonly GuardedWorkspaceFileEffect[] {
  const state = WORKSPACE_PUBLICATION_AUTHORITIES.get(authority);
  if (!state || state.workspace !== workspace
    || !WORKSPACE_PUBLICATION_AUTHORITIES.delete(authority)) {
    throw new Error("Codex workspace publication lacks exact approved-preview authority.");
  }
  return state.effects;
}

export async function snapshotCodexTree(root: string): Promise<CodexTreeSnapshot> {
  const snapshot = await scanTree(await realpath(root), { requireOwnerOnly: false });
  const entries = [...snapshot.entries.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry): CodexTreeSnapshotEntry => Object.freeze({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      size: entry.kind === "file" ? entry.bytes.byteLength : 0,
      sha256: entry.kind === "file" ? entry.sha256 : null,
      modifiedAtNs: entry.modifiedAtNs.toString(),
    }));
  const digest = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
  return Object.freeze({ entries: Object.freeze(entries), digest });
}

async function copyVerifiedWorkspace(
  sourceRoot: string,
  destinationRoot: string,
  appHomeCanonical: string,
): Promise<ReadonlyMap<string, SourceFileEntry>> {
  assertDisjointTrees(sourceRoot, destinationRoot);
  const sourceInfo = await lstat(sourceRoot, { bigint: true });
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    throw new Error("The verified workspace root is not a real directory.");
  }
  const matcher = await loadIgnore(sourceRoot);
  if (matcher.unsupportedCount !== 0) {
    throw new Error("The workspace has unsupported ignore rules; staging fails closed.");
  }
  const sourceFiles = new Map<string, SourceFileEntry>();
  let entriesSeen = 0;
  let bytesSeen = 0;

  const visit = async (
    sourceDirectory: string,
    destinationDirectory: string,
    expectedDirectory: BigIntStats,
  ): Promise<void> => {
    await assertStableDirectory(sourceDirectory, expectedDirectory, sourceRoot, sourceInfo.dev);
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_STAGING_ENTRIES) throw new Error("Codex staging tree is too large.");
      const sourcePath = join(sourceDirectory, dirent.name);
      const rel = relative(sourceRoot, sourcePath).split(sep).join("/");
      await assertStableDirectory(sourceDirectory, expectedDirectory, sourceRoot, sourceInfo.dev);
      const info = await lstat(sourcePath, { bigint: true });
      if (info.isSymbolicLink() || info.dev !== sourceInfo.dev) {
        throw new Error(`Codex staging rejects link or mount escapes: ${rel}`);
      }
      if (await realpath(sourcePath) !== sourcePath) {
        throw new Error(`Codex staging rejects link or mount escapes: ${rel}`);
      }
      if (isWithin(appHomeCanonical, sourcePath)) continue;
      const segments = rel.split("/");
      const privatePath = segments.some((segment) => PRIVATE_TREE_SEGMENTS.has(segment));
      const ignored = matcher.matches(rel, info.isDirectory());
      const protectedRead = classifyPath(rel, "read").verdict !== "allow";
      if (privatePath || ignored || protectedRead) continue;

      const destinationPath = join(destinationDirectory, dirent.name);
      if (info.isDirectory()) {
        await mkdir(destinationPath, { mode: 0o700 });
        await visit(sourcePath, destinationPath, info);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1n) {
        throw new Error(`Codex staging copies only non-linked regular files: ${rel}`);
      }
      if (info.size > BigInt(MAX_STAGING_FILE_BYTES)) {
        throw new Error(`Codex staging file is too large: ${rel}`);
      }
      const bytes = await readBoundFile(sourcePath, info, sourceInfo.dev);
      bytesSeen += bytes.byteLength;
      if (bytesSeen > MAX_STAGING_TREE_BYTES) throw new Error("Codex staging tree is too large.");
      const destinationMode = (Number(info.mode & 0o100n) !== 0) ? 0o700 : 0o600;
      await writeExclusiveFile(destinationPath, bytes, destinationMode);
      sourceFiles.set(rel, Object.freeze({ bytes: Buffer.from(bytes), mode: Number(info.mode & 0o777n) }));
    }
    await assertStableDirectory(sourceDirectory, expectedDirectory, sourceRoot, sourceInfo.dev);
  };

  await visit(sourceRoot, destinationRoot, sourceInfo);
  return sourceFiles;
}

async function scanTree(
  root: string,
  options: Readonly<{ requireOwnerOnly: boolean }>,
): Promise<InternalTreeSnapshot> {
  if (await realpath(root) !== root) {
    throw new Error("Codex staging root moved through a link or mount escape.");
  }
  const rootInfo = await lstat(root, { bigint: true });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Codex staging root is not a real directory.");
  }
  if (options.requireOwnerOnly && (Number(rootInfo.mode) & 0o077) !== 0) {
    throw new Error("Codex staging root is not owner-only.");
  }
  const rootXattrs = await readStagingXattrs(root);
  const rootXattrDigest = rootXattrs.digest;
  await assertStableDirectory(root, rootInfo, root, rootInfo.dev);
  const entries = new Map<string, TreeEntry>();
  let count = 0;
  let bytesSeen = 0;
  const visit = async (directory: string, expectedDirectory: BigIntStats): Promise<void> => {
    await assertStableDirectory(directory, expectedDirectory, root, rootInfo.dev);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      count += 1;
      if (count > MAX_STAGING_ENTRIES) throw new Error("Codex staging tree is too large.");
      const path = join(directory, child.name);
      const rel = relative(root, path).split(sep).join("/");
      await assertStableDirectory(directory, expectedDirectory, root, rootInfo.dev);
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink() || info.dev !== rootInfo.dev) {
        throw new Error(`Codex staging rejects link or mount effects: ${rel}`);
      }
      const mode = Number(info.mode & 0o777n);
      if (options.requireOwnerOnly && (mode & 0o077) !== 0) {
        throw new Error(`Codex staging entry is not owner-only: ${rel}`);
      }
      if (info.isDirectory()) {
        if (await realpath(path) !== path) {
          throw new Error(`Codex staging rejects link or mount effects: ${rel}`);
        }
        const xattrs = await readStagingXattrs(path);
        await assertStableDirectory(path, info, root, rootInfo.dev);
        entries.set(rel, Object.freeze({
          path: rel,
          kind: "directory",
          mode,
          dev: info.dev,
          ino: info.ino,
          modifiedAtNs: info.mtimeNs,
          xattrDigest: xattrs.digest,
        }));
        await visit(path, info);
      } else if (info.isFile() && info.nlink === 1n) {
        if (await realpath(path) !== path) {
          throw new Error(`Codex staging rejects link or mount effects: ${rel}`);
        }
        if (info.size > BigInt(MAX_STAGING_FILE_BYTES)) {
          throw new Error(`Codex staging file is too large: ${rel}`);
        }
        const bytes = await readBoundFile(path, info, rootInfo.dev);
        const xattrs = await readStagingXattrs(path);
        const afterXattr = await lstat(path, { bigint: true });
        if (!sameStableFile(info, afterXattr)) throw new Error(`File changed while staging: ${rel}`);
        bytesSeen += bytes.byteLength;
        if (bytesSeen > MAX_STAGING_TREE_BYTES) throw new Error("Codex staging tree is too large.");
        entries.set(rel, Object.freeze({
          path: rel,
          kind: "file",
          mode,
          dev: info.dev,
          ino: info.ino,
          modifiedAtNs: info.mtimeNs,
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          xattrDigest: xattrs.digest,
          xattrsOnlyProvenance: xattrs.onlyProvenance,
        }));
      } else {
        throw new Error(`Codex staging rejects linked or special effects: ${rel}`);
      }
    }
    await assertStableDirectory(directory, expectedDirectory, root, rootInfo.dev);
  };
  await visit(root, rootInfo);
  return {
    rootDevice: rootInfo.dev,
    rootInode: rootInfo.ino,
    rootMode: Number(rootInfo.mode & 0o777n),
    rootXattrDigest,
    entries,
  };
}

async function assertStableDirectory(
  path: string,
  expected: BigIntStats,
  root: string,
  rootDevice: bigint,
): Promise<void> {
  const canonical = await realpath(path);
  const current = await lstat(path, { bigint: true });
  if (canonical !== path || !current.isDirectory() || current.isSymbolicLink()
    || current.dev !== rootDevice || current.dev !== expected.dev || current.ino !== expected.ino
    || current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs
    || !isWithin(root, canonical)) {
    throw new Error(`Codex staging directory changed or escaped while traversing: ${path}`);
  }
}

async function readBoundFile(path: string, expected: BigIntStats, rootDevice: bigint): Promise<Buffer> {
  if (expected.isSymbolicLink() || !expected.isFile() || expected.dev !== rootDevice
    || expected.nlink !== 1n) {
    throw new Error(`Codex staging rejects linked files: ${path}`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStableFile(expected, opened)) throw new Error(`File changed while staging: ${path}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameStableFile(opened, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error(`File changed while staging: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.nlink === 1n && right.nlink === 1n;
}

async function writeExclusiveFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
}

function assertExactStagingEffects(
  initial: InternalTreeSnapshot,
  current: InternalTreeSnapshot,
  expected: ReadonlyMap<string, PreviewEffect>,
): void {
  assertSameStagingRoot(initial, current);
  const mutableDirectoryPaths = new Set<string>();
  for (const effect of expected.values()) {
    let parent = dirname(effect.path).split(sep).join("/");
    while (parent !== "." && parent !== "") {
      mutableDirectoryPaths.add(parent);
      parent = dirname(parent).split(sep).join("/");
    }
  }

  for (const [path, before] of initial.entries) {
    const after = current.entries.get(path);
    const effect = expected.get(path);
    if (before.kind === "directory") {
      if (!after || after.kind !== "directory" || after.mode !== before.mode
        || after.dev !== before.dev || after.ino !== before.ino
        || after.xattrDigest !== before.xattrDigest
        || (!mutableDirectoryPaths.has(path) && after.modifiedAtNs !== before.modifiedAtNs)) {
        throw new Error(`Unpreviewed effect or metadata change in staging: ${path}`);
      }
      if (effect) throw new Error(`A Codex file preview targets a directory: ${path}`);
      continue;
    }
    if (!effect) {
      if (!sameTreeEntry(before, after)) {
        throw new Error(`Unpreviewed effect or metadata change in staging: ${path}`);
      }
      continue;
    }
    if (effect.kind === "delete") {
      if (after !== undefined) throw new Error(`Codex delete effect does not match preview: ${path}`);
      continue;
    }
    if (effect.kind !== "update" || !after || after.kind !== "file"
      || effect.after === null || !after.bytes.equals(effect.after)
      || after.mode !== before.mode || after.xattrDigest !== before.xattrDigest) {
      throw new Error(`Codex staged effect does not match its exact preview: ${path}`);
    }
  }

  for (const [path, after] of current.entries) {
    if (initial.entries.has(path)) continue;
    if (after.kind === "directory") {
      const coversChild = [...expected.values()].some((effect) =>
        effect.kind === "add" && (effect.path.startsWith(`${path}/`)));
      if (!coversChild || after.mode !== 0o700) {
        throw new Error(`Unpreviewed effect or metadata change in staging: ${path}`);
      }
      continue;
    }
    const effect = expected.get(path);
    if (!effect || effect.kind !== "add" || effect.after === null
      || !after.bytes.equals(effect.after)
      || (after.mode !== 0o600 && after.mode !== 0o700)
      || (after.xattrDigest !== EMPTY_XATTR_DIGEST && !after.xattrsOnlyProvenance)) {
      throw new Error(`Unpreviewed effect or metadata change in staging: ${path}`);
    }
  }

  for (const effect of expected.values()) {
    const initialEntry = initial.entries.get(effect.path);
    const currentEntry = current.entries.get(effect.path);
    if (effect.kind === "add" && (initialEntry !== undefined || currentEntry?.kind !== "file")) {
      throw new Error(`Codex add effect is missing or mismatched: ${effect.path}`);
    }
    if (effect.kind === "update" && (initialEntry?.kind !== "file" || currentEntry?.kind !== "file")) {
      throw new Error(`Codex update effect is missing or mismatched: ${effect.path}`);
    }
    if (effect.kind === "delete" && (initialEntry?.kind !== "file" || currentEntry !== undefined)) {
      throw new Error(`Codex delete effect is missing or mismatched: ${effect.path}`);
    }
  }
}

function assertSameStagingRoot(
  initial: InternalTreeSnapshot,
  current: InternalTreeSnapshot,
): void {
  if (current.rootDevice !== initial.rootDevice || current.rootInode !== initial.rootInode
    || current.rootMode !== initial.rootMode || current.rootMode !== 0o700
    || current.rootXattrDigest !== initial.rootXattrDigest) {
    throw new Error("Codex staging root has an unpreviewed metadata or identity change.");
  }
}

function sameTreeEntry(left: TreeEntry | undefined, right: TreeEntry | undefined): boolean {
  if (left === undefined && right === undefined) return true;
  if (!left || !right || left.kind !== right.kind || left.path !== right.path
    || left.mode !== right.mode || left.dev !== right.dev || left.ino !== right.ino
    || left.modifiedAtNs !== right.modifiedAtNs || left.xattrDigest !== right.xattrDigest) {
    return false;
  }
  return left.kind === "directory" || (right.kind === "file"
    && left.sha256 === right.sha256 && left.bytes.equals(right.bytes));
}

async function readStagingXattrs(path: string): Promise<{ readonly digest: string; readonly onlyProvenance: boolean }> {
  if (process.platform !== "darwin") return { digest: EMPTY_XATTR_DIGEST, onlyProvenance: false };
  const names = (await runStagingXattr([path])).trim().split("\n").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name).update("\0");
    hash.update((await runStagingXattr(["-px", name, path])).replace(/\s/g, "").toLowerCase()).update("\0");
  }
  return { digest: hash.digest("hex"), onlyProvenance: names.length > 0 && names.every((name) => name === "com.apple.provenance") };
}

function runStagingXattr(args: readonly string[]): Promise<string> {
  return new Promise<string>((resolveDigest, rejectDigest) => {
    const child = spawn("/usr/bin/xattr", [...args], {
      cwd: "/",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let bytes = 0;
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectDigest(new Error("Codex staging extended-attribute inspection failed."));
    };
    const timer = setTimeout(fail, 2_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1_024) fail();
      else output += chunk.toString("utf8");
    });
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) rejectDigest(new Error("Codex staging extended-attribute inspection failed."));
      else resolveDigest(output);
    });
  });
}

interface TextLine {
  readonly text: string;
  readonly newline: boolean;
}

function applyUnifiedTextDiff(before: Buffer, diff: string, path: string): Buffer {
  const sourceText = decodeExactUtf8(before, path);
  if (diff.includes("\r")) throw new Error(`Codex patch diff must use LF line endings: ${path}`);
  const source = splitTextLines(sourceText);
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const output: TextLine[] = [];
  let sourceIndex = 0;
  let index = 0;
  let hunkCount = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
      if (!match) throw new Error(`Codex patch hunk is malformed: ${path}`);
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      const expectedSourceIndex = oldCount === 0 ? oldStart : oldStart - 1;
      if (!Number.isSafeInteger(expectedSourceIndex) || expectedSourceIndex < sourceIndex
        || expectedSourceIndex > source.length) {
        throw new Error(`Codex patch hunk is out of order: ${path}`);
      }
      output.push(...source.slice(sourceIndex, expectedSourceIndex));
      sourceIndex = expectedSourceIndex;
      index += 1;
      let consumedOld = 0;
      let producedNew = 0;
      while (index < lines.length && !lines[index]!.startsWith("@@ ")) {
        const patchLine = lines[index]!;
        if (/^(diff --git |index |--- |\+\+\+ )/.test(patchLine)) {
          throw new Error(`Codex patch contains multiple file sections: ${path}`);
        }
        const prefix = patchLine[0];
        if (prefix !== " " && prefix !== "+" && prefix !== "-") {
          throw new Error(`Codex patch line is malformed: ${path}`);
        }
        const text = patchLine.slice(1);
        const noNewline = lines[index + 1] === "\\ No newline at end of file";
        if (prefix === " " || prefix === "-") {
          const existing = source[sourceIndex];
          if (!existing || existing.text !== text || existing.newline === noNewline) {
            throw new Error(`Codex patch pre-image does not match: ${path}`);
          }
          sourceIndex += 1;
          consumedOld += 1;
          if (prefix === " ") {
            output.push(existing);
            producedNew += 1;
          }
        } else {
          output.push({ text, newline: !noNewline });
          producedNew += 1;
        }
        index += noNewline ? 2 : 1;
      }
      if (consumedOld !== oldCount || producedNew !== newCount) {
        throw new Error(`Codex patch hunk counts do not match: ${path}`);
      }
      hunkCount += 1;
      continue;
    }
    if (/^(diff --git |index |--- |\+\+\+ )/.test(line)) {
      if (hunkCount !== 0) throw new Error(`Codex patch header is misplaced: ${path}`);
      index += 1;
      continue;
    }
    throw new Error(`Codex patch contains an unknown line: ${path}`);
  }
  if (hunkCount === 0) throw new Error(`Codex patch has no unified diff hunk: ${path}`);
  output.push(...source.slice(sourceIndex));
  return Buffer.from(output.map((line) => `${line.text}${line.newline ? "\n" : ""}`).join(""), "utf8");
}

function splitTextLines(text: string): TextLine[] {
  if (text.length === 0) return [];
  const lines: TextLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ text: text.slice(start), newline: false });
      break;
    }
    lines.push({ text: text.slice(start, newline), newline: true });
    start = newline + 1;
  }
  return lines;
}

function decodeExactUtf8(bytes: Buffer, path: string): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Codex patch supports exact UTF-8 text only: ${path}`);
  }
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new Error(`Codex patch supports exact UTF-8 text only: ${path}`);
  }
  return value;
}

function normalizeRelativePatchPath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096
    || value.includes("\0") || value.includes("\\") || isAbsolute(value)
    || /(^|\/)\.\.($|\/)/.test(value)) {
    throw new Error("Codex patch path must stay inside staging.");
  }
  const normalized = value.replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.endsWith("/")
    || normalized.split("/").some((segment) => segment === "" || segment === ".")) {
    throw new Error("Codex patch path must be canonical and relative.");
  }
  return normalized;
}

function isExactPatchChange(value: unknown): value is CodexPatchChange {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === 3 && ["path", "kind", "diff"].every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
  })
    && typeof value.path === "string" && typeof value.diff === "string"
    && (value.kind === "add" || value.kind === "update" || value.kind === "delete");
}

function requireStagingState(staging: CodexStagingWorkspace): StagingState {
  const state = STAGING_STATE.get(staging);
  if (!state) throw new Error("Codex staging workspace is not authentic.");
  return state;
}

function requireActiveStaging(staging: CodexStagingWorkspace): StagingState {
  const state = requireStagingState(staging);
  if (!state.active) throw new Error("Codex staging workspace is already discarded.");
  return state;
}

function requirePreviewState(preview: CodexPatchPreview): PreviewState {
  const state = PREVIEW_STATE.get(preview as object);
  if (!state) throw new Error("Codex patch preview is not authentic.");
  return state;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Codex ${label} is invalid.`);
  }
}

function assertDisjointTrees(left: string, right: string): void {
  if (isWithin(left, right) || isWithin(right, left)) {
    throw new Error("Codex staging and the real workspace must not overlap.");
  }
}

async function canonicalProspectivePath(path: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path;
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertExactOwnerMarker(path: string, expected: string): Promise<void> {
  const before = await lstat(path, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : before.uid;
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== currentUid
    || (Number(before.mode) & 0o777) !== 0o600 || before.nlink !== 1n) {
    throw new Error("Codex staging owner marker is not an exact owner-only file.");
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) {
      throw new Error("Codex staging owner marker changed while binding.");
    }
    const content = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs || content !== expected) {
      throw new Error("Codex staging owner marker changed or mismatched.");
    }
  } finally {
    await handle.close();
  }
}

async function reclaimStaleStagingRuns(stagingRoot: string, rootDevice: bigint): Promise<void> {
  const names = (await readdir(stagingRoot))
    .filter((name) => STAGING_OWNER_PATTERN.test(name))
    .sort()
    .slice(0, MAX_RECLAIMED_RUNS);
  for (const name of names) {
    const match = STAGING_OWNER_PATTERN.exec(name);
    if (!match) continue;
    const runName = `run-${match[1]}`;
    const markerPath = join(stagingRoot, name);
    const runPath = join(stagingRoot, runName);
    try {
      const markerInfo = await lstat(markerPath, { bigint: true });
      const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : markerInfo.uid;
      if (markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.dev !== rootDevice
        || markerInfo.uid !== currentUid || (Number(markerInfo.mode) & 0o777) !== 0o600
        || markerInfo.nlink !== 1n) continue;
      const handle = await open(markerPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let content: string;
      try {
        content = await handle.readFile("utf8");
        if (Buffer.byteLength(content, "utf8") > 4_096) continue;
      } finally {
        await handle.close();
      }
      const parsed: unknown = JSON.parse(content);
      if (!isPlainRecord(parsed) || Reflect.ownKeys(parsed).length !== 5
        || parsed.version !== 1 || parsed.runName !== runName || parsed.nonce !== match[1]
        || !Number.isSafeInteger(parsed.pid) || (parsed.pid as number) < 1
        || typeof parsed.workspaceDigest !== "string"
        || !/^[0-9a-f]{64}$/.test(parsed.workspaceDigest)) continue;
      if (processIsAlive(parsed.pid as number)) continue;
      const runInfo = await lstat(runPath, { bigint: true });
      if (runInfo.isSymbolicLink() || !runInfo.isDirectory() || runInfo.dev !== rootDevice
        || runInfo.uid !== currentUid || (Number(runInfo.mode) & 0o777) !== 0o700) continue;
      await removeNoFollowTree(runPath, rootDevice, runInfo);
      await assertExactOwnerMarker(markerPath, content);
      await unlink(markerPath);
      const active = ACTIVE_STAGING_RUNS.get(runPath);
      const activeState = active && STAGING_STATE.get(active);
      if (activeState) activeState.active = false;
      ACTIVE_STAGING_RUNS.delete(runPath);
    } catch {
      // Invalid, live, or concurrently changed roots are decoys and remain.
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function removeExactStagingRun(
  runPath: string,
  claim: PrivateDirectoryClaim,
  store: PrivateStore,
): Promise<void> {
  await store.assertDirectoryClaim(claim);
  const rootInfo = await lstat(runPath, { bigint: true });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Codex staging cleanup lost its exact run root.");
  }
  await removeNoFollowTree(runPath, rootInfo.dev, rootInfo);
}

async function removeNoFollowTree(
  path: string,
  rootDevice: bigint,
  expectedRoot?: BigIntStats,
  budget: { count: number } = { count: 0 },
): Promise<void> {
  budget.count += 1;
  if (budget.count > MAX_STAGING_ENTRIES + 1) {
    throw new Error("Codex staging cleanup exceeded its entry bound.");
  }
  const before = await lstat(path, { bigint: true });
  if (expectedRoot && (before.dev !== expectedRoot.dev || before.ino !== expectedRoot.ino)) {
    throw new Error("Codex staging cleanup root identity changed.");
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  if (before.dev !== rootDevice) {
    throw new Error("Codex staging cleanup refuses a mounted directory.");
  }
  const names = await readdir(path);
  for (const name of names) {
    if (name === "." || name === ".." || name.includes(sep) || name.includes("\0")) {
      throw new Error("Codex staging cleanup found an invalid entry name.");
    }
    await removeNoFollowTree(join(path, name), rootDevice, undefined, budget);
    const current = await lstat(path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()
      || current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error("Codex staging cleanup directory identity changed.");
    }
  }
  const after = await lstat(path, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink()
    || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("Codex staging cleanup directory identity changed before removal.");
  }
  await rmdir(path);
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
