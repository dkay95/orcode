import assert from "node:assert/strict";
import test from "node:test";
import {
  errorMessage,
  formatUsd,
  hasCode,
  isRecord,
  truncate,
} from "../src/utils.js";

test("isRecord akzeptiert nur echte Objekte", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord(undefined), false);
});

test("hasCode erkennt Fehlercodes an Objekten", () => {
  assert.equal(hasCode({ code: "ENOENT" }, "ENOENT"), true);
  assert.equal(hasCode({ code: "EPERM" }, "ENOENT"), false);
  assert.equal(hasCode(new Error("x"), "ENOENT"), false);
  assert.equal(hasCode(null, "ENOENT"), false);
  assert.equal(hasCode("ENOENT", "ENOENT"), false);
});

test("errorMessage extrahiert Nachrichten aus beliebigen Werten", () => {
  assert.equal(errorMessage(new Error("kaputt")), "kaputt");
  assert.equal(errorMessage("text"), "text");
  assert.equal(errorMessage(42), "42");
});

test("truncate lässt kurze Texte unverändert", () => {
  assert.equal(truncate("kurz", 10), "kurz");
  assert.equal(truncate("genau zehn!", 11), "genau zehn!");
});

test("truncate kürzt lange Texte mit Hinweiszeile", () => {
  const long = "x".repeat(100);
  assert.equal(truncate(long, 10), `${"x".repeat(10)}\n… gekürzt …`);
});

test("formatUsd formatiert Beträge mit adaptiver Genauigkeit", () => {
  assert.equal(formatUsd(1.23456), "$1.235");
  assert.equal(formatUsd(0.001), "$0.00100");
  assert.equal(formatUsd(0), "$0.00000");
});
