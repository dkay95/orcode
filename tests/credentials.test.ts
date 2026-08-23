import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CredentialStore } from "../src/credentials.js";
import * as credentialsModule from "../src/credentials.js";
import { PosixPrivateStoreAdapter, PrivateStore } from "../src/private-store.js";

const TEST_KEY_PREFIX = `${["sk", "or", "v1"].join("-")}-`;

function fakeStore(options: {
  failOnSet?: boolean;
  setFailureDetail?: string;
  failAfterSet?: boolean;
  ignoreSet?: boolean;
  failOnDelete?: boolean;
  refuseDelete?: boolean;
  vanishBeforeDeleteResult?: boolean;
  deleteBehavior?: "throw-before" | "delete-then-throw" | "replace-then-throw";
  replacementOnDelete?: string;
  failGetCalls?: number[];
  getFailureDetail?: string;
} = {}) {
  const values = new Map<string, string>();
  const calls: string[] = [];
  let getCalls = 0;
  const createEntry = (service: string, account: string) => {
    const key = `${service}/${account}`;
    calls.push(`entry:${key}`);
    return {
      async getPassword() {
        calls.push(`get:${key}`);
        getCalls += 1;
        if (options.failGetCalls?.includes(getCalls)) {
          throw new Error(options.getFailureDetail ?? "synthetic read failure");
        }
        return values.get(key);
      },
      async setPassword(password: string) {
        calls.push(`set:${key}`);
        if (options.failOnSet) {
          throw new Error(options.setFailureDetail ?? `backend rejected ${password}`);
        }
        if (options.ignoreSet) {
          return;
        }
        values.set(key, password);
        if (options.failAfterSet) {
          throw new Error(`backend failed after writing ${password}`);
        }
      },
      async deleteCredential() {
        calls.push(`delete:${key}`);
        if (options.deleteBehavior === "throw-before") {
          throw new Error("synthetic delete refusal");
        }
        if (options.deleteBehavior === "delete-then-throw") {
          values.delete(key);
          throw new Error("synthetic delete completion ambiguity");
        }
        if (options.deleteBehavior === "replace-then-throw") {
          values.set(key, options.replacementOnDelete ?? "replacement");
          throw new Error("synthetic concurrent replacement");
        }
        if (options.failOnDelete) {
          throw new Error(`backend rejected ${values.get(key)}`);
        }
        if (options.refuseDelete) {
          return false;
        }
        if (options.vanishBeforeDeleteResult) {
          values.delete(key);
          return false;
        }
        return values.delete(key);
      },
    };
  };
  const store = new CredentialStore(createEntry);
  return { store, values, calls, createEntry };
}

type SlotKind = "inference" | "management";
type SlotRef = { version: 1; kind: SlotKind; id: string };
type FutureCredentialStore = CredentialStore & {
  reserveSlot(kind: SlotKind): SlotRef;
  writeSlot(slot: SlotRef, secret: string): Promise<void>;
  readSlot(slot: SlotRef): Promise<string | null>;
  deleteSlot(slot: SlotRef): Promise<boolean>;
  getOrCreateAccountHmacKey(): Promise<Uint8Array>;
};

function versioned(store: CredentialStore): FutureCredentialStore {
  return store as FutureCredentialStore;
}

function normalizeProviderSecret(value: string): string {
  return (credentialsModule as typeof credentialsModule & {
    normalizeProviderSecret(value: string): string;
  }).normalizeProviderSecret(value);
}

function serializedError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const record = error as Error & {
    cause?: unknown;
    persistenceState?: unknown;
  };
  return JSON.stringify({
    name: record.name,
    message: record.message,
    cause: record.cause,
    persistenceState: record.persistenceState,
  });
}

test("provider secret normalization strips only outer Unicode whitespace and has no shape rule", () => {
  const body = `${["sk", "or", "v1"].join("-")}-${"a".repeat(48)}`;
  assert.equal(normalizeProviderSecret(`\u00a0\r\n${body}\r\n\u2003`), body);
  assert.equal(normalizeProviderSecret("x"), "x");
});

test("provider secret normalization rejects embedded whitespace, NUL, ANSI, and controls", () => {
  for (const invalid of [
    `prefix ${"a".repeat(30)}`,
    `prefix\t${"a".repeat(30)}`,
    `prefix\0${"a".repeat(30)}`,
    `prefix\u001b[31m${"a".repeat(30)}`,
    `prefix\u0007${"a".repeat(30)}`,
    "\u00a0\r\n\u2003",
  ]) {
    assert.throws(
      () => normalizeProviderSecret(invalid),
      /ungültig|Steuer|Leerzeichen/i,
      JSON.stringify(invalid.slice(0, 8)),
    );
  }
});

test("versioned slots are unique, exact, isolated from legacy slots, and reserve without keychain calls", async () => {
  const { store: legacyStore, values, calls } = fakeStore();
  const store = versioned(legacyStore);
  const legacyKey = `${TEST_KEY_PREFIX}legacy-inference-key-123456`;
  const keyA = `${TEST_KEY_PREFIX}candidate-a-123456789012`;
  const keyB = `${TEST_KEY_PREFIX}candidate-b-123456789012`;
  await store.set("inference", legacyKey);
  calls.length = 0;

  const first = store.reserveSlot("inference");
  const second = store.reserveSlot("inference");
  assert.notEqual(first.id, second.id);
  assert.match(first.id, /^v1:inference:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(calls, [], "reservation must not instantiate or call a keychain entry");

  await store.writeSlot(first, keyA);
  await store.writeSlot(second, keyB);
  assert.equal(await store.readSlot(first), keyA);
  assert.equal(await store.readSlot(second), keyB);
  assert.equal(await store.get("inference"), legacyKey);
  assert.equal(await store.deleteSlot(first), true);
  assert.equal(await store.readSlot(first), null);
  assert.equal(await store.get("inference"), legacyKey);
  assert.equal(
    values.has(`de.routercode.openrouter/provider-slot:${second.id}`),
    true,
  );
  assert.equal(
    values.has("de.routercode.openrouter/inference-api-key"),
    true,
  );
});

test("concurrent slot reservations are collision-free and still make zero keychain calls", async () => {
  const { store: legacyStore, calls } = fakeStore();
  const store = versioned(legacyStore);
  const refs = await Promise.all(
    Array.from({ length: 512 }, async () => store.reserveSlot("management")),
  );
  assert.equal(new Set(refs.map((slot) => slot.id)).size, refs.length);
  assert.deepEqual(calls, []);
});

test("versioned slot methods reject forged and noncanonical references before keychain access", async () => {
  const { store: legacyStore, calls } = fakeStore();
  const store = versioned(legacyStore);
  const forged = [
    { version: 1, kind: "inference", id: "inference-api-key" },
    { version: 1, kind: "inference", id: "v1:management:123e4567-e89b-42d3-a456-426614174000" },
    { version: 1, kind: "inference", id: "v1:inference:123E4567-E89B-42D3-A456-426614174000" },
    { version: 2, kind: "inference", id: "v1:inference:123e4567-e89b-42d3-a456-426614174000" },
  ] as unknown as SlotRef[];

  for (const ref of forged) {
    await assert.rejects(store.readSlot(ref), /ungültig|Slot/i);
    await assert.rejects(store.writeSlot(ref, "x"), /ungültig|Slot/i);
    await assert.rejects(store.deleteSlot(ref), /ungültig|Slot/i);
  }
  assert.deepEqual(calls, []);
});

test("slot methods snapshot mutable reference primitives before deriving a keychain account", async () => {
  const { store: legacyStore, values, calls } = fakeStore();
  const store = versioned(legacyStore);
  const reserved = store.reserveSlot("inference");
  const account = `de.routercode.openrouter/provider-slot:${reserved.id}`;
  values.set(account, "canonical-secret");
  let idReads = 0;
  const mutable = {
    version: 1 as const,
    kind: "inference" as const,
    get id(): string {
      idReads += 1;
      return idReads <= 2 ? reserved.id : "not-canonical";
    },
  };

  assert.equal(await store.readSlot(mutable), "canonical-secret");
  assert.equal(calls.some((call) => call.includes("provider-slot:not-canonical")), false);
});

test("slot writes require the exact fresh reservation object and reject canonical structural forgeries", async () => {
  const { store: legacyStore, calls } = fakeStore();
  const store = versioned(legacyStore);
  const reserved = store.reserveSlot("management");
  const structuralForgery = { ...reserved };
  const unreserved = {
    version: 1 as const,
    kind: "management" as const,
    id: "v1:management:123e4567-e89b-42d3-a456-426614174000",
  };

  await assert.rejects(store.writeSlot(structuralForgery, "x"), /reserviert|Slot/i);
  await assert.rejects(store.writeSlot(unreserved, "x"), /reserviert|Slot/i);
  assert.deepEqual(calls, []);
});

test("slot reservation rejects a generated UUID collision without keychain access", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const { createEntry, calls } = fakeStore();
  const store = versioned(new CredentialStore(createEntry, () => uuid));

  store.reserveSlot("inference");
  assert.throws(() => store.reserveSlot("inference"), /Kollision|reserviert|Slot/i);
  assert.deepEqual(calls, []);
});

test("slot write refuses an occupied account and never deletes its pre-existing secret", async () => {
  const options = { failOnSet: true };
  const { store: legacyStore, values, calls } = fakeStore(options);
  const store = versioned(legacyStore);
  const slot = store.reserveSlot("inference");
  const account = `de.routercode.openrouter/provider-slot:${slot.id}`;
  const preExisting = "pre-existing-opaque-secret";
  values.set(account, preExisting);
  calls.length = 0;

  await assert.rejects(store.writeSlot(slot, "candidate"), /belegt|speichern|Slot/i);
  assert.equal(values.get(account), preExisting);
  assert.equal(calls.some((call) => call.startsWith("set:")), false);
  assert.equal(calls.some((call) => call.startsWith("delete:")), false);
});

test("slot write does not clean up when a failed set never proved the candidate was written", async () => {
  const { store: legacyStore, calls } = fakeStore({ failOnSet: true });
  const store = versioned(legacyStore);
  const slot = store.reserveSlot("management");

  await assert.rejects(store.writeSlot(slot, "candidate"), /speichern/i);
  assert.equal(calls.some((call) => call.startsWith("delete:")), false);
});

test("candidate slot write verifies exact readback, cleans failure, and redacts the candidate", async () => {
  const options = { ignoreSet: true };
  const { store: legacyStore, values } = fakeStore(options);
  const store = versioned(legacyStore);
  const slot = store.reserveSlot("inference");
  const secret = `${TEST_KEY_PREFIX}slot-readback-secret-123456`;

  await assert.rejects(store.writeSlot(slot, secret), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /nicht unverändert|speichern/i);
    return true;
  });
  assert.equal(values.has(`de.routercode.openrouter/provider-slot:${slot.id}`), false);
});

test("candidate slot partial-write and delete failures fail closed without exposing secret bytes", async () => {
  const options = { failAfterSet: true, failOnDelete: false };
  const { store: legacyStore } = fakeStore(options);
  const store = versioned(legacyStore);
  const slot = store.reserveSlot("management");
  const secret = `${TEST_KEY_PREFIX}slot-partial-write-secret-123456`;
  await assert.rejects(store.writeSlot(slot, secret), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /speichern/i);
    return true;
  });
  options.failAfterSet = false;
  await store.writeSlot(slot, secret);
  options.failOnDelete = true;
  await assert.rejects(store.deleteSlot(slot), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /löschen/i);
    return true;
  });
  assert.equal(await store.readSlot(slot), secret);
});

test("slot deletion treats delete-then-throw with exact absent readback as success", async () => {
  const options: Parameters<typeof fakeStore>[0] = {};
  const { store: legacyStore, values } = fakeStore(options);
  const store = versioned(legacyStore);
  const slot = store.reserveSlot("inference");
  await store.writeSlot(slot, "candidate");
  options.deleteBehavior = "delete-then-throw";

  assert.equal(await store.deleteSlot(slot), true);
  assert.equal(values.has(`de.routercode.openrouter/provider-slot:${slot.id}`), false);
});

test("slot deletion reports unchanged only when exact original bytes remain", async () => {
  const options: Parameters<typeof fakeStore>[0] = {};
  const { store: legacyStore } = fakeStore(options);
  const store = versioned(legacyStore);
  const slot = store.reserveSlot("inference");
  await store.writeSlot(slot, "candidate");
  options.deleteBehavior = "throw-before";

  await assert.rejects(store.deleteSlot(slot), (error: unknown) => {
    assert.equal(
      (error as Error & { persistenceState?: string }).persistenceState,
      "unchanged",
    );
    return true;
  });
  assert.equal(await store.readSlot(slot), "candidate");
});

test("slot deletion reports unknown when readback differs from the exact original bytes", async () => {
  const replacement = "concurrent-replacement";
  const options: Parameters<typeof fakeStore>[0] = {
    replacementOnDelete: replacement,
  };
  const { store: legacyStore } = fakeStore(options);
  const store = versioned(legacyStore);
  const slot = store.reserveSlot("management");
  await store.writeSlot(slot, "candidate");
  options.deleteBehavior = "replace-then-throw";

  await assert.rejects(store.deleteSlot(slot), (error: unknown) => {
    assert.equal(
      (error as Error & { persistenceState?: string }).persistenceState,
      "unknown",
    );
    return true;
  });
  assert.equal(await store.readSlot(slot), replacement);
});

test("account HMAC key is stable, exactly 32 bytes, and uses only the fixed internal account", async () => {
  const { store: legacyStore, values } = fakeStore();
  const store = versioned(legacyStore);
  const first = await store.getOrCreateAccountHmacKey();
  const second = await store.getOrCreateAccountHmacKey();

  assert.equal(first.byteLength, 32);
  assert.deepEqual(second, first);
  assert.deepEqual([...values.keys()], [
    "de.routercode.openrouter/provider-account-hmac-v1",
  ]);
});

test("account HMAC initialization is single-flight within one CredentialStore", async () => {
  let stored: string | undefined;
  let entryCreations = 0;
  let generations = 0;
  let releaseRead!: () => void;
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const store = versioned(new CredentialStore(
    () => {
      entryCreations += 1;
      return {
        async getPassword() {
          await readGate;
          return stored;
        },
        async setPassword(password: string) { stored = password; },
        async deleteCredential() { stored = undefined; return true; },
      };
    },
    undefined,
    () => new Uint8Array(32).fill(++generations),
  ));

  const firstPromise = store.getOrCreateAccountHmacKey();
  const secondPromise = store.getOrCreateAccountHmacKey();
  await Promise.resolve();
  releaseRead();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.deepEqual(first, second);
  assert.equal(entryCreations, 1);
  assert.equal(generations, 1);
});

test("independent CredentialStore instances serialize HMAC initialization to one persisted key", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "orcode-hmac-lease-"));
  let stored: string | undefined;
  let setCalls = 0;
  const createEntry = () => ({
    async getPassword() { return stored; },
    async setPassword(password: string) {
      setCalls += 1;
      if (setCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      stored = password;
    },
    async deleteCredential() { stored = undefined; return true; },
  });
  const firstStore = versioned(new CredentialStore(
    createEntry,
    undefined,
    () => new Uint8Array(32).fill(1),
    appHome,
  ));
  const secondStore = versioned(new CredentialStore(
    createEntry,
    undefined,
    () => new Uint8Array(32).fill(2),
    appHome,
  ));

  const [first, second] = await Promise.all([
    firstStore.getOrCreateAccountHmacKey(),
    secondStore.getOrCreateAccountHmacKey(),
  ]);
  assert.deepEqual(first, second);
  assert.equal(setCalls, 1);
});

test("an absent canonical HMAC claim root is privately created before the first exact key is persisted", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orcode-hmac-absent-root-"));
  const globalRoot = join(fixture, "canonical-root");
  const generated = Uint8Array.from({ length: 32 }, (_, index) => index);
  let stored: string | undefined;
  let writes = 0;
  const store = versioned(new CredentialStore(
    () => ({
      async getPassword() { return stored; },
      async setPassword(password: string) { writes += 1; stored = password; },
      async deleteCredential() { stored = undefined; return true; },
    }),
    undefined,
    () => generated,
    globalRoot,
  ));

  const actual = await store.getOrCreateAccountHmacKey();

  assert.deepEqual(actual, generated);
  assert.equal(actual.byteLength, 32);
  assert.deepEqual(Buffer.from(stored ?? "", "base64"), Buffer.from(generated));
  assert.equal(writes, 1);
  assert.equal((await stat(globalRoot)).isDirectory(), true);
  if (process.platform !== "win32") {
    assert.equal((await stat(globalRoot)).mode & 0o777, 0o700);
  }
});

test("a second independent store reads the same key after canonical HMAC root creation", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orcode-hmac-absent-root-reader-"));
  const globalRoot = join(fixture, "canonical-root");
  let stored: string | undefined;
  let writes = 0;
  let generations = 0;
  const createEntry = () => ({
    async getPassword() { return stored; },
    async setPassword(password: string) { writes += 1; stored = password; },
    async deleteCredential() { stored = undefined; return true; },
  });
  const firstStore = versioned(new CredentialStore(
    createEntry,
    undefined,
    () => new Uint8Array(32).fill(++generations),
    globalRoot,
  ));
  const secondStore = versioned(new CredentialStore(
    createEntry,
    undefined,
    () => new Uint8Array(32).fill(++generations),
    globalRoot,
  ));

  const first = await firstStore.getOrCreateAccountHmacKey();
  const second = await secondStore.getOrCreateAccountHmacKey();

  assert.deepEqual(second, first);
  assert.equal(writes, 1);
  assert.equal(generations, 1);
});

test("symlinked and file canonical HMAC roots fail closed before any keychain write", async (t) => {
  for (const kind of ["symlink", "file"] as const) {
    await t.test(kind, async () => {
      const fixture = await mkdtemp(join(tmpdir(), `orcode-hmac-invalid-root-${kind}-`));
      const globalRoot = join(fixture, "canonical-root");
      const outside = join(fixture, "outside");
      const sentinel = `outside-${kind}-must-stay-exact`;
      await mkdir(outside);
      await writeFile(join(outside, "sentinel.txt"), sentinel);
      if (kind === "symlink") {
        await symlink(outside, globalRoot, "dir");
      } else {
        await writeFile(globalRoot, sentinel);
      }
      let writes = 0;
      let generations = 0;
      const store = versioned(new CredentialStore(
        () => ({
          async getPassword() { return undefined; },
          async setPassword() { writes += 1; },
          async deleteCredential() { return false; },
        }),
        undefined,
        () => { generations += 1; return new Uint8Array(32).fill(3); },
        globalRoot,
      ));

      await assert.rejects(store.getOrCreateAccountHmacKey(), (error: unknown) => {
        const serialized = serializedError(error);
        assert.match(serialized, /CredentialStoreError|Schlüsselbund/);
        assert.doesNotMatch(serialized, new RegExp(globalRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(serialized, new RegExp(sentinel));
        return true;
      });
      assert.equal(writes, 0);
      assert.equal(generations, 0);
      assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), sentinel);
      if (kind === "file") assert.equal(await readFile(globalRoot, "utf8"), sentinel);
    });
  }
});

test("canonical HMAC root creation failure exposes a fixed error and persists no secret", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orcode-hmac-root-create-failure-"));
  const blocker = join(fixture, "not-a-directory");
  const sentinel = "root-create-failure-private-sentinel";
  await writeFile(blocker, sentinel);
  const globalRoot = join(blocker, "canonical-root");
  let writes = 0;
  let generations = 0;
  const store = versioned(new CredentialStore(
    () => ({
      async getPassword() { return undefined; },
      async setPassword() { writes += 1; },
      async deleteCredential() { return false; },
    }),
    undefined,
    () => { generations += 1; return new Uint8Array(32).fill(5); },
    globalRoot,
  ));

  await assert.rejects(store.getOrCreateAccountHmacKey(), (error: unknown) => {
    const serialized = serializedError(error);
    assert.match(serialized, /CredentialStoreError|Schlüsselbund/);
    assert.doesNotMatch(serialized, new RegExp(sentinel));
    assert.doesNotMatch(serialized, new RegExp(globalRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
  assert.equal(writes, 0);
  assert.equal(generations, 0);
  assert.equal(await readFile(blocker, "utf8"), sentinel);
});

test("a successful HMAC initialization leaves its permanent claim while future readers use the persisted key", async () => {
  const globalRoot = await mkdtemp(join(tmpdir(), "orcode-hmac-permanent-claim-"));
  let stored: string | undefined;
  let writes = 0;
  const createEntry = () => ({
    async getPassword() { return stored; },
    async setPassword(password: string) { writes += 1; stored = password; },
    async deleteCredential() { stored = undefined; return true; },
  });
  const firstStore = versioned(new CredentialStore(
    createEntry,
    undefined,
    () => new Uint8Array(32).fill(7),
    globalRoot,
  ));

  const first = await firstStore.getOrCreateAccountHmacKey();
  const claimsAfterWrite = await readdir(globalRoot);
  assert.equal(claimsAfterWrite.length, 1);
  assert.equal((await stat(join(globalRoot, claimsAfterWrite[0]!))).isDirectory(), true);

  const secondStore = versioned(new CredentialStore(
    createEntry,
    undefined,
    () => new Uint8Array(32).fill(8),
    globalRoot,
  ));
  const second = await secondStore.getOrCreateAccountHmacKey();
  assert.deepEqual(second, first);
  assert.equal(writes, 1);
  assert.deepEqual(await readdir(globalRoot), claimsAfterWrite);
});

test("HMAC initialization never deletes a foreign directory swapped into the acquired claim path", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orcode-hmac-claim-swap-"));
  const globalRoot = join(fixture, "global");
  const outside = join(fixture, "foreign-replacement");
  const movedClaim = join(fixture, "original-claim");
  const sentinel = "foreign sentinel must survive";
  await mkdir(globalRoot);
  await mkdir(outside, { mode: 0o755 });
  await writeFile(join(outside, "must-survive.txt"), sentinel);
  let stored: string | undefined;
  let swapped = false;
  const store = versioned(new CredentialStore(
    () => ({
      async getPassword() { return stored; },
      async setPassword(password: string) {
        const [claimName] = await readdir(globalRoot);
        assert.ok(claimName);
        const claimPath = join(globalRoot, claimName);
        await rename(claimPath, movedClaim);
        await rename(outside, claimPath);
        swapped = true;
        stored = password;
      },
      async deleteCredential() { stored = undefined; return true; },
    }),
    undefined,
    () => new Uint8Array(32).fill(9),
    globalRoot,
  ));

  await store.getOrCreateAccountHmacKey();

  assert.equal(swapped, true);
  const [claimName] = await readdir(globalRoot);
  assert.ok(claimName);
  assert.equal(
    await readFile(join(globalRoot, claimName, "must-survive.txt"), "utf8"),
    sentinel,
  );
});

test("a stuck permanent HMAC claim without a key fails closed and remains untouched", async () => {
  const globalRoot = await mkdtemp(join(tmpdir(), "orcode-hmac-stuck-claim-"));
  const claimPath = join(globalRoot, "provider-account-hmac-init.lock");
  const privateStore = new PrivateStore({
    adapter: new PosixPrivateStoreAdapter(),
    root: globalRoot,
  });
  assert.ok(await privateStore.createDirectoryExclusive(claimPath));
  const store = versioned(new CredentialStore(
    () => ({
      async getPassword() { return undefined; },
      async setPassword() { throw new Error("must not write while claim is stuck"); },
      async deleteCredential() { throw new Error("must not delete stuck claim"); },
    }),
    undefined,
    () => new Uint8Array(32).fill(4),
    globalRoot,
  ));

  await assert.rejects(
    store.getOrCreateAccountHmacKey(),
    (error: unknown) => {
      assert.equal(
        (error as Error & { persistenceState?: string }).persistenceState,
        "unknown",
      );
      assert.match((error as Error).message, /belegt|Initialisierung/i);
      return true;
    },
  );
  assert.equal((await stat(claimPath)).isDirectory(), true);
});

test("account HMAC key fails closed and redacts backend error material", async () => {
  const unknown = `${TEST_KEY_PREFIX}hmac-backend-error-secret-123456`;
  const { store: legacyStore } = fakeStore({
    failGetCalls: [1],
    getFailureDetail: `backend exposed ${unknown}`,
  });
  const store = versioned(legacyStore);

  await assert.rejects(store.getOrCreateAccountHmacKey(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(unknown));
    assert.match(error.message, /Schlüsselbund|lesen/i);
    return true;
  });
});

test("slot and HMAC initial-read failures expose only fixed credential-boundary metadata", async (t) => {
  for (const operation of ["slot", "hmac"] as const) {
    await t.test(operation, async () => {
      const backendOnly = `opaque/backend/${operation}/private-value`;
      const { store: legacyStore } = fakeStore({
        failGetCalls: [1],
        getFailureDetail: `untrusted backend detail ${backendOnly}`,
      });
      const store = versioned(legacyStore);
      const action = operation === "slot"
        ? store.readSlot(store.reserveSlot("inference"))
        : store.getOrCreateAccountHmacKey();

      await assert.rejects(action, (error: unknown) => {
        assert.doesNotMatch(serializedError(error), new RegExp(backendOnly));
        assert.match(serializedError(error), /Schlüsselbund|CredentialStoreError/);
        return true;
      });
    });
  }
});

test("credential store separates inference and management keys", async () => {
  const { store, values } = fakeStore();
  const inference = `${TEST_KEY_PREFIX}inference-test-key-123456`;
  const management = `${TEST_KEY_PREFIX}management-test-key-654321`;

  assert.equal(await store.get("inference"), null);
  await store.set("inference", inference);
  await store.set("management", management);

  assert.equal(await store.get("inference"), inference);
  assert.equal(await store.get("management"), management);
  assert.equal(await store.has("inference"), true);
  assert.equal(values.size, 2);

  assert.equal(await store.delete("inference"), true);
  assert.equal(await store.get("inference"), null);
  assert.equal(await store.get("management"), management);
});

test("legacy fixed slots share common normalization without a provider shape gate", async () => {
  const { store, values, calls } = fakeStore();
  await store.set("inference", "\u00a0\r\nx\r\n\u2003");
  assert.equal(await store.get("inference"), "x");
  assert.equal(values.get("de.routercode.openrouter/inference-api-key"), "x");

  calls.length = 0;
  await assert.rejects(
    store.set("management", `bad\u001b[31m${"x".repeat(24)}`),
    /ungültig|Steuer|Leerzeichen/i,
  );
  assert.deepEqual(calls, []);
  assert.equal(values.size, 1);

  values.set(
    "de.routercode.openrouter/management-api-key",
    `stored\0${"x".repeat(24)}`,
  );
  await assert.rejects(store.get("management"), /ungültig|Steuer|Leerzeichen/i);
  assert.equal(values.size, 2);
});

test("deleting a key that was never stored reports false", async () => {
  const { store, values } = fakeStore();
  assert.equal(await store.delete("management"), false);
  assert.equal(await store.has("management"), false);
  assert.equal(values.size, 0);
});

test("credential store errors never include the secret", async () => {
  const { store } = fakeStore({ failOnSet: true });
  const secret = `${TEST_KEY_PREFIX}secret-that-must-not-leak-123`;

  await assert.rejects(
    store.set("inference", secret),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test("credential errors omit opaque candidate, previous, and backend-only bytes from every field", async () => {
  const previous = "opaque-previous-private-value";
  const candidate = "opaque-candidate-private-value";
  const backendOnly = "opaque-backend-only-private-value";
  const options: Parameters<typeof fakeStore>[0] = {};
  const { store } = fakeStore(options);
  await store.set("inference", previous);
  options.failOnSet = true;
  options.setFailureDetail = `${candidate}|${previous}|${backendOnly}`;

  await assert.rejects(store.set("inference", candidate), (error: unknown) => {
    const serialized = serializedError(error);
    assert.doesNotMatch(serialized, new RegExp(candidate));
    assert.doesNotMatch(serialized, new RegExp(previous));
    assert.doesNotMatch(serialized, new RegExp(backendOnly));
    return true;
  });
});

test("credential deletion fails closed when the backend leaves the stored key in place", async () => {
  const { store } = fakeStore({ refuseDelete: true });
  const secret = `${TEST_KEY_PREFIX}delete-must-be-retryable-123`;
  await store.set("inference", secret);

  await assert.rejects(store.delete("inference"), /nicht gelöscht|löschen/);
  assert.equal(await store.get("inference"), secret);
});

test("credential deletion errors redact the stored secret", async () => {
  const { store } = fakeStore({ failOnDelete: true });
  const secret = `${TEST_KEY_PREFIX}delete-error-secret-12345`;
  await store.set("inference", secret);

  await assert.rejects(store.delete("inference"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  assert.equal(await store.get("inference"), secret);
});

test("credential deletion accepts a concurrently absent entry as completed", async () => {
  const { store } = fakeStore({ vanishBeforeDeleteResult: true });
  const secret = `${TEST_KEY_PREFIX}concurrent-delete-secret-123`;
  await store.set("management", secret);

  assert.equal(await store.delete("management"), true);
  assert.equal(await store.get("management"), null);
});

test("a failed credential replacement restores the previously stored key", async () => {
  const options = { failAfterSet: false };
  const { store } = fakeStore(options);
  const previous = `${TEST_KEY_PREFIX}previous-persisted-key-123`;
  const candidate = `${TEST_KEY_PREFIX}candidate-must-rollback-456`;
  await store.set("inference", previous);
  options.failAfterSet = true;

  await assert.rejects(store.set("inference", candidate), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(candidate));
    return true;
  });
  options.failAfterSet = false;
  assert.equal(await store.get("inference"), previous);
});

test("a failed first credential save removes any partially written candidate", async () => {
  const options = { failAfterSet: true };
  const { store } = fakeStore(options);
  const candidate = `${TEST_KEY_PREFIX}first-candidate-must-rollback-789`;

  await assert.rejects(store.set("management", candidate));
  options.failAfterSet = false;
  assert.equal(await store.get("management"), null);
});

test("credential save verifies the exact persisted value", async () => {
  const options = { ignoreSet: false };
  const { store } = fakeStore(options);
  const previous = `${TEST_KEY_PREFIX}previous-verified-key-123`;
  const candidate = `${TEST_KEY_PREFIX}ignored-candidate-key-456`;
  await store.set("inference", previous);
  options.ignoreSet = true;

  await assert.rejects(store.set("inference", candidate), /nicht gespeichert|speichern/);
  options.ignoreSet = false;
  assert.equal(await store.get("inference"), previous);
});

test("an unreadable rollback readback is reported as unsafe even when no key existed before", async () => {
  const options = {
    failAfterSet: true,
    refuseDelete: true,
    failGetCalls: [3],
  };
  const { store, values } = fakeStore(options);
  const candidate = `${TEST_KEY_PREFIX}unknown-rollback-candidate-123`;

  await assert.rejects(store.set("inference", candidate), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /nicht sicher wiederhergestellt|unbekannt/i);
    assert.equal(
      (error as Error & { persistenceState?: string }).persistenceState,
      "unknown",
    );
    return true;
  });
  assert.equal([...values.values()].includes(candidate), true);
});

test("credential errors centrally redact previous and unknown backend key material", async (t) => {
  const previous = `${TEST_KEY_PREFIX}previous-secret-in-read-error-123`;
  const candidate = `${TEST_KEY_PREFIX}candidate-for-read-error-456`;
  await t.test("previous key in replacement readback", async () => {
    const options = {
      failGetCalls: [] as number[],
      getFailureDetail: `backend exposed ${previous}`,
    };
    const { store } = fakeStore(options);
    await store.set("inference", previous);
    options.failGetCalls = [4];

    await assert.rejects(store.set("inference", candidate), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(previous));
      assert.doesNotMatch(error.message, new RegExp(candidate));
      assert.match(error.message, /\[REDACTED/);
      return true;
    });
  });

  await t.test("unknown key in initial backend read failure", async () => {
    const unknown = `${TEST_KEY_PREFIX}unknown-backend-read-secret-789`;
    const { store } = fakeStore({
      failGetCalls: [1],
      getFailureDetail: `backend exposed ${unknown}`,
    });

    await assert.rejects(store.get("management"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(unknown));
      assert.match(error.message, /\[REDACTED/);
      return true;
    });
  });
});
