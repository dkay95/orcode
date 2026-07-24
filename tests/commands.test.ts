import assert from "node:assert/strict";
import test from "node:test";
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
    shouldReplaceCredential(new Error("Der OpenRouter-Key ist abgelaufen.")),
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
