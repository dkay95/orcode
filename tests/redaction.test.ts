import assert from "node:assert/strict";
import test from "node:test";
import {
  redactRunEvent,
  redactText,
  scanForSecrets,
} from "../src/redaction.js";
import type { AgentRunEvent } from "../src/types.js";

const joined = (parts: string[], separator = ""): string =>
  parts.join(separator);

const syntheticSecrets = (): Array<{
  kind: string;
  placeholder: string;
  value: string;
}> => [
  {
    kind: "OpenRouter-Key",
    placeholder: "[REDACTED_OPENROUTER_KEY]",
    value: `${joined(["sk", "or", "v1"], "-")}-${"a".repeat(40)}`,
  },
  {
    kind: "Anthropic-Key",
    placeholder: "[REDACTED_ANTHROPIC_KEY]",
    value: `${joined(["sk", "ant"], "-")}-${"b".repeat(32)}`,
  },
  {
    kind: "API-Key (sk-…)",
    placeholder: "[REDACTED_API_KEY]",
    value: `${joined(["sk", "project"], "-")}-${"c".repeat(28)}`,
  },
  {
    kind: "AWS-Access-Key",
    placeholder: "[REDACTED_AWS_KEY_ID]",
    value: `${joined(["A", "K", "I", "A"])}${"D".repeat(16)}`,
  },
  {
    kind: "AWS-Secret-Key",
    placeholder: "[REDACTED_AWS_SECRET]",
    value: `aws_secret_access_key=${"E".repeat(40)}`,
  },
  {
    kind: "GitHub-Token",
    placeholder: "[REDACTED_GITHUB_TOKEN]",
    value: `${joined(["ghp", ""], "_")}${"f".repeat(30)}`,
  },
  {
    kind: "GitLab-Token",
    placeholder: "[REDACTED_GITLAB_TOKEN]",
    value: `${joined(["glpat", ""], "-")}${"g".repeat(28)}`,
  },
  {
    kind: "Slack-Token",
    placeholder: "[REDACTED_SLACK_TOKEN]",
    value: `${joined(["xoxb", ""], "-")}${"1".repeat(12)}-${"h".repeat(16)}`,
  },
  {
    kind: "Google-API-Key",
    placeholder: "[REDACTED_GOOGLE_KEY]",
    value: `${joined(["AI", "za"])}${"i".repeat(35)}`,
  },
  {
    kind: "npm-Token",
    placeholder: "[REDACTED_NPM_TOKEN]",
    value: `${joined(["npm", ""], "_")}${"j".repeat(36)}`,
  },
  {
    kind: "Bearer-Token",
    placeholder: "Bearer [REDACTED_TOKEN]",
    value: `Bearer ${"k".repeat(22)}7`,
  },
  {
    kind: "JWT",
    placeholder: "[REDACTED_JWT]",
    value: `${joined(["eyJ", "h".repeat(10)])}.${joined(["eyJ", "p".repeat(10)])}.${"l".repeat(16)}`,
  },
  {
    kind: "Private Key",
    placeholder: "[REDACTED_PRIVATE_KEY]",
    value: `${joined(["-----BEGIN OPENSSH PRIVATE", "KEY-----"], " ")}\n${"m".repeat(32)}\n${joined(["-----END OPENSSH PRIVATE", "KEY-----"], " ")}`,
  },
];

test("the central registry scans and redacts the union of supported secret categories", () => {
  const secrets = syntheticSecrets();
  const input = secrets.map(({ value }) => value).join("\n");

  assert.deepEqual(
    scanForSecrets(input).map(({ kind }) => kind),
    secrets.map(({ kind }) => kind),
  );

  const redacted = redactText(input);
  for (const { placeholder, value } of secrets) {
    assert.ok(redacted.includes(placeholder), `missing ${placeholder}`);
    assert.ok(!redacted.includes(value), `secret survived for ${placeholder}`);
  }
});

test("redaction preserves harmless text byte for byte", () => {
  const documentedPrefix = `${["sk", "or", "v1"].join("-")}-`;
  const harmless = [
    "sk-test",
    `documented prefix only: ${documentedPrefix}`,
    "Bearer token",
    "ghp_short",
    "ordinary unicode: Grüße 🐕",
    "line one\r\nline two\twith spacing",
    "https://openrouter.ai/api/v1/chat/completions",
  ].join("\n");
  assert.equal(redactText(harmless), harmless);
});

test("recursive event redaction sanitizes nested strings without mutating the input", () => {
  const secret = syntheticSecrets()[0]!.value;
  const event: AgentRunEvent = {
    type: "tool-end",
    id: "tool-1",
    number: 3,
    name: "run_command",
    input: {
      command: `deploy --token=${secret}`,
      nested: [1, true, null, { credential: secret }],
    },
    output: {
      stdout: [`connected with ${secret}`],
      exitCode: 0,
      ok: true,
    },
    durationMs: 42,
    timestamp: 99,
  };
  const before = structuredClone(event);

  const redacted = redactRunEvent(event);

  assert.deepEqual(event, before);
  assert.notStrictEqual(redacted, event);
  assert.equal(redacted.type, event.type);
  assert.equal(redacted.durationMs, 42);
  assert.equal(redacted.timestamp, 99);
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(secret));
  assert.match(JSON.stringify(redacted), /\[REDACTED_OPENROUTER_KEY\]/);
});

test("every human-readable run-event field is recursively redacted", () => {
  const secret = syntheticSecrets()[0]!.value;
  const events: AgentRunEvent[] = [
    { type: "run-start", model: secret, maxSteps: 4, prompt: secret, timestamp: 1 },
    { type: "reasoning", model: secret, step: 1, delta: secret, timestamp: 2 },
    { type: "text", delta: secret, timestamp: 3 },
    {
      type: "tool-start",
      id: "t",
      number: 1,
      name: "tool",
      input: { prompt: secret },
      timestamp: 4,
    },
    {
      type: "tool-output",
      id: "t",
      number: 1,
      stream: "stdout",
      text: secret,
      timestamp: 5,
    },
    {
      type: "tool-end",
      id: "t",
      number: 1,
      name: "tool",
      input: { prompt: secret },
      output: { text: secret },
      durationMs: 2,
      timestamp: 6,
    },
    {
      type: "tool-error",
      id: "t",
      number: 1,
      name: "tool",
      input: { prompt: secret },
      error: secret,
      durationMs: 2,
      timestamp: 7,
    },
    {
      type: "notice",
      level: "warn",
      code: "secret",
      message: secret,
      hint: secret,
      actions: [{ key: "r", label: secret }],
      timestamp: 8,
    },
  ];

  const stored = events.map((event) => redactRunEvent(event));
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(secret));
  assert.ok(
    (JSON.stringify(stored).match(/\[REDACTED_OPENROUTER_KEY\]/g) ?? [])
      .length >= 12,
  );
});
