import assert from "node:assert/strict";
import test from "node:test";
import { formatSecretWarning, scanForSecrets } from "../src/secrets.js";

// Alle „Keys" hier sind offensichtliche Fakes bzw. dokumentierte
// Beispielwerte (AKIAIOSFODNN7EXAMPLE ist das AWS-Doku-Beispiel) — keine
// echten Zugangsdaten.

test("erkennt OpenRouter-Keys ohne Doppelzählung durch das generische sk-Muster", () => {
  const findings = scanForSecrets(`key = sk-or-v1-${"a".repeat(64)}`);
  assert.deepEqual(findings, [{ kind: "OpenRouter-Key", count: 1 }]);
});

test("erkennt AWS-, GitHub- und Slack-Muster mit Trefferzahl", () => {
  const text = [
    "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
    `token: ghp_${"b".repeat(36)}`,
    `xoxb-${"1".repeat(11)}-${"2".repeat(11)}-abcdef`,
  ].join("\n");
  const findings = scanForSecrets(text);
  assert.deepEqual(findings, [
    { kind: "AWS-Access-Key", count: 1 },
    { kind: "GitHub-Token", count: 1 },
    { kind: "Slack-Token", count: 1 },
  ]);
});

test("erkennt Private-Key-Header und zählt mehrere Vorkommen", () => {
  const text =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----\n".repeat(2);
  const findings = scanForSecrets(text);
  assert.deepEqual(findings, [{ kind: "Private Key", count: 2 }]);
});

test("generischer sk-Key trifft, sk-ant wird separat gemeldet", () => {
  assert.deepEqual(scanForSecrets(`sk-${"c".repeat(30)}`), [
    { kind: "API-Key (sk-…)", count: 1 },
  ]);
  assert.deepEqual(scanForSecrets(`sk-ant-${"d".repeat(40)}`), [
    { kind: "Anthropic-Key", count: 1 },
  ]);
});

test("normaler Code und Prosa bleiben sauber", () => {
  const text = [
    "const result = scanForSecrets(input);",
    "// kurze Tokens wie sk-123 oder akzente sind keine Keys",
    "Bitte rotiere den Key in der Konfigurationsdatei.",
  ].join("\n");
  assert.deepEqual(scanForSecrets(text), []);
});

test("formatSecretWarning nennt Quelle, Kategorien und OpenRouter-Hinweis", () => {
  const warning = formatSecretWarning("Das Ergebnis von read_file", [
    { kind: "AWS-Access-Key", count: 2 },
  ]);
  assert.match(warning, /Das Ergebnis von read_file/);
  assert.match(warning, /AWS-Access-Key ×2/);
  assert.match(warning, /OpenRouter/);
});
