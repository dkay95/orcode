import assert from "node:assert/strict";
import test from "node:test";
import { CredentialStore } from "../src/credentials.js";

function fakeStore(options: { failOnSet?: boolean } = {}) {
  const values = new Map<string, string>();
  const store = new CredentialStore((service, account) => {
    const key = `${service}/${account}`;
    return {
      async getPassword() {
        return values.get(key);
      },
      async setPassword(password: string) {
        if (options.failOnSet) {
          throw new Error(`backend rejected ${password}`);
        }
        values.set(key, password);
      },
      async deleteCredential() {
        return values.delete(key);
      },
    };
  });
  return { store, values };
}

test("credential store separates inference and management keys", async () => {
  const { store, values } = fakeStore();
  const inference = "sk-or-v1-inference-test-key-123456";
  const management = "sk-or-v1-management-test-key-654321";

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
  const secret = "sk-or-v1-secret-that-must-not-leak-123";

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
