import assert from "node:assert/strict";
import test from "node:test";
import { SpendUnavailableError, assertSpendAvailable } from "../src/agent.js";
import { shouldReplaceCredential } from "../src/commands.js";
import { OpenRouterHttpError } from "../src/openrouter.js";

test("only unusable credentials trigger replacement", () => {
  assert.equal(
    shouldReplaceCredential(new OpenRouterHttpError(401, "User not found")),
    true,
  );
  assert.equal(
    shouldReplaceCredential(new OpenRouterHttpError(403, "Forbidden")),
    true,
  );
  assert.equal(
    shouldReplaceCredential(
      new SpendUnavailableError("key-expired", "Der OpenRouter-Key ist abgelaufen."),
    ),
    true,
  );
  assert.equal(
    shouldReplaceCredential(new Error("OpenRouter ist nicht erreichbar")),
    false,
  );
  assert.equal(
    shouldReplaceCredential(new OpenRouterHttpError(500, "Provider down")),
    false,
  );
});

function spendError(balance: Parameters<typeof assertSpendAvailable>[0]) {
  try {
    assertSpendAvailable(balance);
  } catch (error) {
    assert.ok(
      error instanceof SpendUnavailableError,
      `Erwartet wurde ein SpendUnavailableError, bekommen: ${String(error)}`,
    );
    return error;
  }
  throw new assert.AssertionError({
    message: "assertSpendAvailable hat nichts geworfen.",
  });
}

test("an exhausted balance never deletes a valid key (B3)", () => {
  // The verdict must not depend on the wording of a German message: the old
  // /aufgebraucht|abgelaufen/ regex deleted keys that OpenRouter had just
  // confirmed as valid.
  const noCredits = spendError({
    key: { limit: null, limitRemaining: null },
    credits: { totalCredits: 5, totalUsage: 5, remaining: 0 },
  });
  assert.equal(noCredits.reason, "account-credits");
  assert.match(noCredits.message, /aufgebraucht/);
  assert.equal(shouldReplaceCredential(noCredits), false);

  const noKeyLimit = spendError({ key: { limit: 10, limitRemaining: 0 } });
  assert.equal(noKeyLimit.reason, "key-limit");
  assert.equal(shouldReplaceCredential(noKeyLimit), false);

  // A plain error that merely *reads* like an expiry stays harmless too.
  assert.equal(
    shouldReplaceCredential(new Error("Der Cache ist abgelaufen.")),
    false,
  );
});

test("an expired key is still replaced", () => {
  const expired = spendError({
    key: {
      limit: null,
      limitRemaining: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  assert.equal(expired.reason, "key-expired");
  assert.equal(shouldReplaceCredential(expired), true);
});
