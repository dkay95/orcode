import assert from "node:assert/strict";
import test from "node:test";
import { CredentialStore } from "../src/credentials.js";

const TEST_KEY_PREFIX = `${["sk", "or", "v1"].join("-")}-`;

function fakeStore(options: {
  failOnSet?: boolean;
  failAfterSet?: boolean;
  ignoreSet?: boolean;
  failOnDelete?: boolean;
  refuseDelete?: boolean;
  vanishBeforeDeleteResult?: boolean;
  failGetCalls?: number[];
  getFailureDetail?: string;
} = {}) {
  const values = new Map<string, string>();
  let getCalls = 0;
  const store = new CredentialStore((service, account) => {
    const key = `${service}/${account}`;
    return {
      async getPassword() {
        getCalls += 1;
        if (options.failGetCalls?.includes(getCalls)) {
          throw new Error(options.getFailureDetail ?? "synthetic read failure");
        }
        return values.get(key);
      },
      async setPassword(password: string) {
        if (options.failOnSet) {
          throw new Error(`backend rejected ${password}`);
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
  });
  return { store, values };
}

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

test("credential store rejects malformed keys before touching the keychain", async () => {
  const { store, values } = fakeStore();
  await assert.rejects(store.set("inference", "short"), /ungültig/);
  assert.equal(values.size, 0);
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
