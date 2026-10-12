import readline from "node:readline";

const scenario = process.argv[2] ?? "supported";
const expectedCodexHome = process.argv[3] ?? "/missing-codex-home";
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.exitCode = 2;
    input.close();
    return;
  }

  if (frame?.method === "initialize") {
    if (scenario === "silent-initialize") return;
    if (scenario === "malformed-initialize") {
      process.stdout.write("{not-json\n");
      return;
    }
    if (scenario === "unknown-initialize") {
      send({ unexpected: true });
      return;
    }
    if (scenario === "initialize-error") {
      send({ id: frame.id, error: { code: -32000, message: "initialization refused" } });
      return;
    }
    send({
      id: frame.id,
      result: {
        codexHome: scenario === "wrong-home" ? "/wrong/codex-home" : expectedCodexHome,
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: scenario === "unsupported" ? "codex_cli_rs/0.141.0" : "codex_cli_rs/0.142.5",
        ...(scenario === "extra-initialize-field" ? { futureProtocol: true } : {}),
      },
    });
    return;
  }

  if (frame?.method === "initialized") return;

  if (scenario === "malformed-request") {
    process.stdout.write("[]\n");
    return;
  }
  if (scenario === "unknown-request") {
    send({ id: frame?.id, result: {}, method: "unexpected/response" });
    return;
  }
  send({ id: frame?.id, result: { ok: true, method: frame?.method } });
});

input.on("close", () => {
  process.exitCode ??= 0;
});
