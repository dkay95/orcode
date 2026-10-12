import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfigLockTarget } from "./config-file.js";
import { PrivateStore, type PrivateDirectoryClaim } from "./private-store.js";
import { hasCode, isRecord } from "./utils.js";

const CONFIG_WRITER_LOCK_SUFFIX = ".writer.lock";
const OWNER_LIMIT = 4_096;
const MAX_ACQUIRE_ATTEMPTS = 6_000;
const RETRY_DELAY_MS = 5;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROCESS_INSTANCE_ID = randomUUID();
const PROCESS_HOST = hostname();

interface ConfigWriterOwnerV1 {
  version: 1;
  ownerId: string;
  processInstanceId: string;
  pid: number;
  hostname: string;
  acquiredAt: number;
  expiresAt: number;
}

interface HeldConfigWriterLock {
  store: PrivateStore;
  claim: PrivateDirectoryClaim;
  rawOwner: string;
}

const processTails = new Map<string, Promise<void>>();
const activeConfigWrite = new AsyncLocalStorage<string>();

export interface ConfigWriteOwnership {
  readonly canonicalPath: string;
  assertHeld(): Promise<void>;
}

export interface ConfigWriteLockOptions {
  signal?: AbortSignal;
}

/**
 * Serializes every whole-config publication for one resolved config path.
 *
 * The in-process queue is paired with an exact opaque PrivateStore directory
 * claim, so independent orcode processes participate in the same ownership.
 * Node has no mkdirat/unlinkat API: PrivateStore revalidates every observable
 * identity boundary, while retaining the documented same-user syscall gap.
 */
export async function withConfigWriteLock<T>(
  configPath: string,
  task: (ownership: ConfigWriteOwnership) => Promise<T>,
  options: ConfigWriteLockOptions = {},
): Promise<T> {
  return withConfigWriteLocks(
    [configPath],
    (ownerships) => task(ownerships[0]!),
    options,
  );
}

/** Acquires multiple config paths in one canonical order, preventing AB/BA. */
export async function withConfigWriteLocks<T>(
  configPaths: readonly string[],
  task: (ownerships: readonly ConfigWriteOwnership[]) => Promise<T>,
  options: ConfigWriteLockOptions = {},
): Promise<T> {
  const resolvedTargets = await Promise.all(
    configPaths.map((path) => resolveConfigLockTarget(path)),
  );
  const targetsByIdentity = new Map(
    resolvedTargets.map((target) => [target.identityKey, target]),
  );
  const targets = [...targetsByIdentity.values()].sort((left, right) =>
    left.identityKey.localeCompare(right.identityKey));
  if (targets.length === 0) {
    throw new Error("At least one config writer path is required.");
  }
  if (activeConfigWrite.getStore() !== undefined) {
    throw new Error("Nested config writer ownership is not supported.");
  }
  throwIfAborted(options.signal);
  const entries = targets.map((target) => {
    const predecessor = processTails.get(target.identityKey) ?? Promise.resolve();
    let releaseProcess!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      releaseProcess = resolveCurrent;
    });
    const tail = predecessor.then(() => current);
    processTails.set(target.identityKey, tail);
    void tail.then(() => {
      if (processTails.get(target.identityKey) === tail) {
        processTails.delete(target.identityKey);
      }
    });
    return { target, predecessor, releaseProcess };
  });

  const held: HeldConfigWriterLock[] = [];
  let result!: T;
  let primaryError: unknown;
  let completed = false;
  try {
    await waitForPredecessor(
      Promise.all(entries.map((entry) => entry.predecessor)).then(() => undefined),
      options.signal,
    );
    for (const entry of entries) {
      const acquired = await acquireCrossProcessLock(
        entry.target.canonicalPath,
        entry.target.identityKey,
        options.signal,
      );
      held.push(acquired);
      throwIfAborted(options.signal);
    }
    const ownerships = Object.freeze(held.map((entry, index) => Object.freeze({
      canonicalPath: targets[index]!.canonicalPath,
      assertHeld: () => assertCrossProcessLock(entry),
    })));
    throwIfAborted(options.signal);
    result = await activeConfigWrite.run(
      targets.map((target) => target.identityKey).join("\0"),
      () => task(ownerships),
    );
    completed = true;
  } catch (error) {
    primaryError = error;
  } finally {
    let releaseFailed = false;
    for (const entry of [...held].reverse()) {
      try {
        await entry.store.releaseDirectoryClaim(entry.claim, entry.rawOwner);
      } catch {
        releaseFailed = true;
      }
    }
    for (const entry of entries) entry.releaseProcess();
    if (!completed) throw primaryError;
    if (releaseFailed) {
      throw new Error("Config writer ownership release could not be verified.");
    }
  }
  return result;
}

async function acquireCrossProcessLock(
  configPath: string,
  identityKey: string,
  signal?: AbortSignal,
): Promise<HeldConfigWriterLock> {
  const configDirectory = dirname(configPath);
  const root = join(dirname(configDirectory), ".orcode-config-writer-locks");
  const key = createHash("sha256").update(identityKey, "utf8").digest("hex");
  const lockPath = join(root, `${key}${CONFIG_WRITER_LOCK_SUFFIX}`);
  const store = new PrivateStore({ root });
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    let claim: PrivateDirectoryClaim | null;
    try {
      claim = await store.createDirectoryExclusive(lockPath);
    } catch {
      throw new Error("Config writer ownership identity could not be verified.");
    }
    if (claim) {
      if (signal?.aborted) {
        await store.releaseDirectoryClaim(claim, null).catch(() => undefined);
        throw abortFrom(signal);
      }
      const acquiredAt = Date.now();
      const expiresAt = acquiredAt + DEFAULT_LEASE_DURATION_MS;
      if (!Number.isSafeInteger(acquiredAt) || acquiredAt < 0
        || !Number.isSafeInteger(expiresAt)) {
        await store.releaseDirectoryClaim(claim, null).catch(() => undefined);
        throw new Error("Config writer ownership clock is invalid.");
      }
      const owner: ConfigWriterOwnerV1 = {
        version: 1,
        ownerId: randomUUID(),
        processInstanceId: PROCESS_INSTANCE_ID,
        pid: process.pid,
        hostname: PROCESS_HOST,
        acquiredAt,
        expiresAt,
      };
      const rawOwner = `${JSON.stringify(owner)}\n`;
      try {
        await store.writeClaimOwner(claim, rawOwner);
        if (await store.readClaimOwner(claim, OWNER_LIMIT) !== rawOwner) {
          throw new Error("owner-readback-mismatch");
        }
        await store.assertDirectoryClaim(claim);
        return { store, claim, rawOwner };
      } catch {
        let observed: string | null | undefined;
        try {
          observed = await store.readClaimOwner(claim, OWNER_LIMIT);
        } catch (error) {
          if (hasCode(error, "ENOENT")) observed = null;
        }
        if (observed === rawOwner) {
          await store.releaseDirectoryClaim(claim, rawOwner).catch(() => undefined);
        } else if (observed === null) {
          await store.releaseDirectoryClaim(claim, null).catch(() => undefined);
        }
        throw new Error("Config writer ownership could not be published.");
      }
    }

    let adopted: Awaited<ReturnType<PrivateStore["adoptDirectoryClaim"]>>;
    try {
      adopted = await store.adoptDirectoryClaim(lockPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw new Error("Config writer ownership could not be adopted.");
    }
    let rawOwner: string;
    try {
      rawOwner = await store.readClaimOwner(adopted.claim, OWNER_LIMIT);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        if (Date.now() - adopted.modifiedAtMs >= DEFAULT_LEASE_DURATION_MS) {
          try {
            await store.releaseDirectoryClaim(adopted.claim, null);
          } catch {
            throw new Error("Ownerless config writer ownership is ambiguous.");
          }
          continue;
        }
        await waitForWriter(signal);
        continue;
      }
      throw new Error("Config writer ownership is ambiguous.");
    }
    const owner = parseOwner(rawOwner);
    if (!owner) throw new Error("Config writer ownership is invalid.");

    const isDeadLocalProcess = owner.hostname === PROCESS_HOST
      && !processExists(owner.pid);
    if (isDeadLocalProcess) {
      try {
        await store.releaseDirectoryClaim(adopted.claim, rawOwner);
      } catch {
        throw new Error("Stale config writer ownership could not be released.");
      }
      continue;
    }
    await waitForWriter(signal);
  }
  throw new Error("Config writer ownership is busy.");
}

function parseOwner(raw: string): ConfigWriterOwnerV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)
    || Object.keys(value).length !== 7
    || value.version !== 1
    || typeof value.ownerId !== "string"
    || !CANONICAL_UUID.test(value.ownerId)
    || typeof value.processInstanceId !== "string"
    || !CANONICAL_UUID.test(value.processInstanceId)
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.hostname !== "string"
    || value.hostname.length < 1
    || value.hostname.length > 255
    || !Number.isSafeInteger(value.acquiredAt)
    || (value.acquiredAt as number) < 0
    || !Number.isSafeInteger(value.expiresAt)
    || (value.expiresAt as number) <= (value.acquiredAt as number)) {
    return null;
  }
  return value as unknown as ConfigWriterOwnerV1;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function assertCrossProcessLock(held: HeldConfigWriterLock): Promise<void> {
  try {
    await held.store.assertDirectoryClaim(held.claim);
    const rawOwner = await held.store.readClaimOwner(held.claim, OWNER_LIMIT);
    await held.store.assertDirectoryClaim(held.claim);
    const owner = parseOwner(rawOwner);
    if (rawOwner !== held.rawOwner || !owner) {
      throw new Error("config-writer-fence-mismatch");
    }
  } catch {
    throw new Error("Config writer ownership fence was lost.");
  }
}

async function waitForPredecessor(
  predecessor: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await predecessor;
    return;
  }
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortFrom(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([predecessor, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function waitForWriter(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolveWait, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortFrom(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }, RETRY_DELAY_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  throwIfAborted(signal);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortFrom(signal);
}

function abortFrom(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
