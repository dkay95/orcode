import assert from "node:assert/strict";
import test from "node:test";
import {
  SuggestedReplyStreamFilter,
  assertSpendAvailable,
  parseSuggestedReplies,
} from "../src/agent.js";

const healthy = {
  key: {
    limit: 10,
    limitRemaining: 8,
    usage: 2,
  },
  credits: {
    totalCredits: 20,
    totalUsage: 4,
    remaining: 16,
  },
};

test("spend gate accepts available balance", () => {
  assert.doesNotThrow(() => assertSpendAvailable(healthy));
});

test("spend gate blocks empty account credits", () => {
  assert.throws(
    () =>
      assertSpendAvailable({
        ...healthy,
        credits: { totalCredits: 5, totalUsage: 5, remaining: 0 },
      }),
    /Kontoguthaben ist aufgebraucht/,
  );
});

test("spend gate blocks an exhausted key limit", () => {
  assert.throws(
    () =>
      assertSpendAvailable({
        key: { limit: 1, limitRemaining: 0, usage: 1 },
      }),
    /Ausgabenlimit/,
  );
});

test("assistant quick replies are extracted, sanitized, and removed from visible text", () => {
  const parsed = parseSuggestedReplies(
    [
      "Die Tests sind grün.",
      '<routercode_suggestions>["Zeig mir den Diff"," Tests erneut ausführen ","zeig mir den diff",42]</routercode_suggestions>',
    ].join("\n"),
  );
  assert.equal(parsed.text, "Die Tests sind grün.");
  assert.deepEqual(parsed.suggestions, [
    "Zeig mir den Diff",
    "Tests erneut ausführen",
  ]);
});

test("quick-reply block is stripped even when text follows the closing tag", () => {
  const parsed = parseSuggestedReplies(
    [
      "Antwort eins.",
      '<routercode_suggestions>["Weiter"]</routercode_suggestions>',
      "Nachtrag nach dem Block.",
    ].join("\n"),
  );
  assert.equal(parsed.text, "Antwort eins.\nNachtrag nach dem Block.");
  assert.deepEqual(parsed.suggestions, []);
  assert.doesNotMatch(parsed.text, /routercode_suggestions/);
});

test("quick-reply metadata never leaks through chunked streaming", () => {
  const filter = new SuggestedReplyStreamFilter();
  const visible = [
    filter.push("Ergebnis ist fertig.\n<router"),
    filter.push(
      'code_suggestions>["Weiter"]</routercode_suggestions>',
    ),
    filter.finish(),
  ].join("");
  assert.equal(visible, "Ergebnis ist fertig.\n");
  assert.equal(filter.visibleText, visible);
  assert.doesNotMatch(visible, /routercode_suggestions|Weiter/);
});

test("streaming without quick-reply metadata flushes the complete answer", () => {
  const filter = new SuggestedReplyStreamFilter();
  const visible = [
    filter.push("Eine ganz normale "),
    filter.push("Antwort."),
    filter.finish(),
  ].join("");
  assert.equal(visible, "Eine ganz normale Antwort.");
});
