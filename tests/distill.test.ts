import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DISTILL_MODEL_BYTES,
  DISTILL_PASSTHROUGH_BYTES,
  distillDeterministic,
  distillToolOutput,
  type DistillModelCall,
} from "../src/distill.js";

async function freshAppHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "routercode-distill-"));
}

test("output below 2 KB passes through unchanged", async () => {
  const output = "hello\nworld\n";
  const result = await distillToolOutput({ tool: "run_command", output, exitCode: 0 });
  assert.equal(result.text, output);
  assert.equal(result.distilled, false);
  assert.equal(result.modelCalled, false);
});

test("read_file is never distilled, even when huge", async () => {
  const output = "x".repeat(DISTILL_MODEL_BYTES * 2);
  const result = await distillToolOutput({ tool: "read_file", output });
  assert.equal(result.text, output);
  assert.equal(result.distilled, false);
  assert.equal(result.modelCalled, false);
});

test(
  "a 5 KB log with 3 error lines and 200 warnings keeps all 3 error lines verbatim, shrinks under 1 KB, and never calls the model",
  async () => {
    const warnings = Array.from({ length: 200 }, (_, i) => `npm WARN deprecated pkg${i}@1.0.0`);
    const errors = [
      "src/session.ts(219,7): error TS2345: Argument of type 'number'",
      "FAIL tests/session.test.ts > save() schreibt atomar",
      "AssertionError: expected 2 to be 3",
    ];
    const output = [...warnings, ...errors].join("\n") + "\n";
    assert.ok(Buffer.byteLength(output, "utf8") >= 2 * 1024, "fixture must clear the 2 KB floor");
    assert.ok(Buffer.byteLength(output, "utf8") < 20 * 1024, "fixture must stay under the 20 KB ceiling");

    let modelCalled = false;
    const callModel: DistillModelCall = async () => {
      modelCalled = true;
      return { text: "should not be used", costUsd: 1 };
    };

    const result = await distillToolOutput(
      { tool: "run_command", output, exitCode: 0 },
      { callModel },
    );

    for (const errorLine of errors) {
      assert.ok(result.text.includes(errorLine), `missing error line: ${errorLine}`);
    }
    assert.ok(result.distilledBytes < 1024, `expected < 1KB, got ${result.distilledBytes}`);
    assert.equal(modelCalled, false);
    assert.equal(result.modelCalled, false);
  },
);

test("exitCode !== 0 at 50 KB never calls the model (deterministic stage only)", async () => {
  const bigOutput = "line\n".repeat(20_000) + "error: build failed\n";
  assert.ok(Buffer.byteLength(bigOutput, "utf8") > DISTILL_MODEL_BYTES);

  let modelCalls = 0;
  const callModel: DistillModelCall = async () => {
    modelCalls += 1;
    return { text: "compressed", costUsd: 0.01 };
  };

  const result = await distillToolOutput(
    { tool: "run_command", output: bigOutput, exitCode: 1 },
    { callModel },
  );

  assert.equal(modelCalls, 0);
  assert.equal(result.modelCalled, false);
  assert.equal(result.costUsd, 0);
  assert.ok(result.text.includes("error: build failed"));
});

test("identical input served from cache costs $0 on the second call", async () => {
  const appHome = await freshAppHome();
  const output = "distinct log line\n".repeat(2_000);
  assert.ok(Buffer.byteLength(output, "utf8") > DISTILL_MODEL_BYTES);

  let modelCalls = 0;
  const callModel: DistillModelCall = async () => {
    modelCalls += 1;
    return { text: "condensed summary", costUsd: 0.02 };
  };

  const first = await distillToolOutput(
    { tool: "run_command", output, exitCode: 0 },
    { appHome, callModel },
  );
  assert.equal(first.modelCalled, true);
  assert.equal(first.costUsd, 0.02);
  assert.equal(first.text, "condensed summary");

  const second = await distillToolOutput(
    { tool: "run_command", output, exitCode: 0 },
    { appHome, callModel },
  );
  assert.equal(second.costUsd, 0);
  assert.equal(second.modelCalled, false);
  assert.equal(second.text, "condensed summary");
  assert.equal(modelCalls, 1, "the second call must be served from cache");
});

test("without a wired-up model, the >20 KB stage falls back to the deterministic tier instead of failing", async () => {
  const output = "line\n".repeat(20_000) + "error: still broken\n";
  const result = await distillToolOutput({ tool: "run_command", output, exitCode: 0 });
  assert.equal(result.modelCalled, false);
  assert.equal(result.costUsd, 0);
  assert.ok(result.text.includes("error: still broken"));
});

test("ANSI escapes, carriage-return progress lines and npm noise are stripped deterministically", () => {
  const output =
    "[32mok[0m\n" +
    "downloading... 10%\rdownloading... 50%\rdownloading... 100%\n" +
    "npm WARN deprecated foo@1.0.0\n" +
    "npm notice new version available\n" +
    "kept line\n";
  const result = distillDeterministic({ tool: "run_command", output, exitCode: 0 });
  assert.ok(!result.includes("["));
  assert.ok(!result.includes("downloading... 10%"));
  assert.ok(result.includes("downloading... 100%"));
  assert.ok(!result.includes("npm WARN"));
  assert.ok(!result.includes("npm notice"));
  assert.ok(result.includes("kept line"));
});

test("identical consecutive lines fold into '<line> (Nx)'", () => {
  const output = Array.from({ length: 37 }, () => "retrying...").join("\n");
  const result = distillDeterministic({ tool: "run_command", output, exitCode: 0 });
  assert.ok(result.includes("retrying... (37×)"));
  assert.equal(result.split("\n").filter((l) => l.startsWith("retrying...")).length, 1);
});

test("run_command output keeps exit code, all matching error lines, and a deduplicated 60-line tail", () => {
  const noise = Array.from({ length: 100 }, (_, i) => `noise ${i}`);
  const output = [...noise, "panic: something broke", "more noise"].join("\n");
  const result = distillDeterministic({ tool: "run_command", output, exitCode: 2 });
  assert.ok(result.startsWith("exit 2"));
  assert.ok(result.includes("panic: something broke"));
  assert.ok(!result.includes("noise 10\n") || result.includes("noise 40"));
});

test("search_files output is grouped by file with at most 5 hits per file", () => {
  const hits: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    hits.push(`src/a.ts:${i}: match`);
  }
  hits.push("src/b.ts:1: other match");
  const output = hits.join("\n");
  const result = distillDeterministic({ tool: "search_files", output });
  const aHits = result.split("\n").filter((l) => l.startsWith("src/a.ts:"));
  assert.equal(aHits.length, 5);
  assert.ok(result.includes("weitere Treffer in src/a.ts"));
  assert.ok(result.includes("src/b.ts:1: other match"));
});

test("passthrough threshold constant is honoured at the boundary", async () => {
  const justUnder = "a".repeat(DISTILL_PASSTHROUGH_BYTES - 1);
  const result = await distillToolOutput({ tool: "run_command", output: justUnder, exitCode: 0 });
  assert.equal(result.distilled, false);
});
