import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  COMMAND_CATALOG,
  commandTokenIsExact,
  rankSlashCommands,
} from "../src/command-catalog.js";

interface TestCatalogEntry {
  name: string;
  usage: string;
  description: string;
  aliases?: readonly string[];
  handlerId: string;
}

test("slash catalog opens on slash and includes descriptions", () => {
  const commands = rankSlashCommands("/");
  assert.ok(commands.length >= 15);
  assert.equal(commands[0]?.name, "model");
  assert.ok(commands.every((command) => command.description.length > 10));
});

test("slash catalog exposes manual reconnect", () => {
  const reconnect = rankSlashCommands("/reconnect")[0];
  assert.equal(reconnect?.name, "reconnect");
  assert.match(reconnect?.description ?? "", /Verbindung/);
});

test("slash catalog exposes image attachments", () => {
  const image = rankSlashCommands("/image")[0];
  assert.equal(image?.name, "image");
  assert.match(image?.description ?? "", /Bild/);
  assert.equal(rankSlashCommands("/attach")[0]?.name, "image");
});

test("slash catalog exposes /panel use", () => {
  const panel = rankSlashCommands("/panel")[0];
  assert.equal(panel?.name, "panel");
  assert.match(panel?.usage ?? "", /use <n>/);
});

test("slash catalog exposes /resume", () => {
  const resume = rankSlashCommands("/resume")[0];
  assert.equal(resume?.name, "resume");
  assert.match(resume?.description ?? "", /abgebrochen/i);
  assert.match(resume?.usage ?? "", /fortsetzen/);
  assert.match(resume?.usage ?? "", /undo/);
  assert.match(resume?.usage ?? "", /verwerfen/);
});

test("the flat command catalog owns every canonical token, alias, and handler id", async () => {
  const module = await import("../src/command-catalog.js") as unknown as Record<string, unknown>;
  const catalog = module.COMMAND_CATALOG;
  const resolve = module.resolveSlashCommand;

  assert.ok(Array.isArray(catalog), "COMMAND_CATALOG must be the shared flat catalog");
  assert.equal(typeof resolve, "function", "the catalog must expose its resolver");

  const entries = catalog as TestCatalogEntry[];
  const handlerIds = entries.map((entry) => entry.handlerId);
  assert.ok(handlerIds.every(Boolean), "every catalog entry needs a handler id");
  assert.equal(new Set(handlerIds).size, handlerIds.length, "handler ids must be unique");

  const tokens = entries.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]);
  assert.equal(new Set(tokens).size, tokens.length, "canonical tokens and aliases must be unique");

  const resolveCommand = resolve as (input: string) => {
    command: TestCatalogEntry;
    handlerId: string;
    matchedToken: string;
  } | undefined;
  for (const entry of entries) {
    for (const token of [entry.name, ...(entry.aliases ?? [])]) {
      assert.deepEqual(resolveCommand(`/${token} ignored`), {
        command: entry,
        handlerId: entry.handlerId,
        matchedToken: token,
      });
    }
  }
});

test("completion exposes every documented top-level command", () => {
  const names = new Set(rankSlashCommands("/").map((command) => command.name));
  assert.ok(names.has("panel"));
  assert.ok(names.has("resume"));
  assert.ok(names.has("ssh"));
});

test("provider catalog, completion, help, and generated docs expose the one flat dispatcher", () => {
  const provider = rankSlashCommands("/provider")[0];
  const providerDefinition = COMMAND_CATALOG.find((entry) => entry.name === "provider");
  assert.equal(provider?.name, "provider");
  assert.equal(providerDefinition?.handlerId, "provider");
  assert.match(provider?.usage ?? "", /setup/);
  assert.match(provider?.usage ?? "", /connect/);
  assert.match(provider?.usage ?? "", /disconnect/);
  assert.match(provider?.usage ?? "", /logout/);
  assert.match(provider?.description ?? "", /OpenRouter.*Stable/i);
  assert.match(provider?.description ?? "", /Kimi Code Abo.*Preview/);
  assert.match(provider?.description ?? "", /Membership/);
  assert.doesNotMatch(provider?.description ?? "", /Kimi[^;]*Stable/);
  assert.doesNotMatch(provider?.description ?? "", /Kimi[^;]*OAuth/i);
  assert.match(provider?.description ?? "", /Anthropic.*Coming soon/i);
  assert.doesNotMatch(provider?.usage ?? "", /kimi/i);
});

test("slash catalog exposes voice input under /whisper and /voice", () => {
  const whisper = rankSlashCommands("/whisper")[0];
  assert.equal(whisper?.name, "whisper");
  assert.match(whisper?.description ?? "", /Sprach/);
  assert.equal(rankSlashCommands("/voice")[0]?.name, "whisper");
});

test("slash catalog ranks partial command names and aliases", () => {
  assert.deepEqual(
    rankSlashCommands("/th").map((command) => command.name),
    ["think"],
  );
  assert.equal(rankSlashCommands("/perm")[0]?.name, "allow");
  assert.equal(rankSlashCommands("/cred")[0]?.name, "balance");
});

test("exact command detection ignores arguments", () => {
  const think = rankSlashCommands("/think high")[0]!;
  assert.equal(commandTokenIsExact("/think high", think), true);
  assert.equal(commandTokenIsExact("/th", think), false);
});

test("interactive approval and chat commands expose their aliases", () => {
  const approval = rankSlashCommands("/allow")[0]!;
  assert.equal(commandTokenIsExact("/allow", approval), true);
  assert.equal(approval.name, "allow");
  assert.equal(rankSlashCommands("/chat")[0]?.name, "chat");
  assert.equal(rankSlashCommands("/new")[0]?.name, "new");
});

test("compress command exposes selectable contextual subcommands", () => {
  const root = rankSlashCommands("/compress");
  assert.deepEqual(
    root.slice(0, 4).map((command) => command.name),
    [
      "compress",
      "compress model",
      "compress auto",
      "compress always",
    ],
  );
  assert.deepEqual(
    rankSlashCommands("/compress mo").map((command) => command.name),
    ["compress model"],
  );
  assert.deepEqual(
    rankSlashCommands("/compress ").map((command) => command.name),
    [
      "compress model",
      "compress auto",
      "compress always",
      "compress off",
      "compress threshold",
      "compress max-cost",
    ],
  );
  assert.equal(
    commandTokenIsExact("/compress model", root[1]!),
    true,
  );
  assert.equal(
    commandTokenIsExact("/compress", root[1]!),
    false,
  );
});

test("README command bytes are rendered and checked from the shared catalog", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const script = fileURLToPath(new URL("../scripts/render-command-docs.ts", import.meta.url));
  const check = spawnSync(
    process.execPath,
    ["--import", "tsx", script, "--check"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const docsModule = await import("../scripts/render-command-docs.js") as unknown as Record<string, unknown>;
  assert.equal(typeof docsModule.renderCommandDocs, "function");
  assert.equal(typeof docsModule.commandDocsBlock, "function");
  const catalogModule = await import("../src/command-catalog.js") as unknown as Record<string, unknown>;
  const render = docsModule.renderCommandDocs as (entries: readonly TestCatalogEntry[]) => string;
  const block = docsModule.commandDocsBlock as (table: string) => string;
  const generated = render(catalogModule.COMMAND_CATALOG as TestCatalogEntry[]);
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.ok(readme.includes(block(generated)), "README must contain the exact generated block");
  const start = readme.indexOf("<!-- orcode:command-docs:start -->");
  const end = readme.indexOf("<!-- orcode:command-docs:end -->");
  assert.ok(start >= 0 && end > start, "README must carry the command-docs markers in order");
  const readmeBlock = readme.slice(start, end + "<!-- orcode:command-docs:end -->".length);
  const providerRowPattern = /^\| `\/provider` \|[^\n]*$/m;
  const generatedProviderRow = generated.match(providerRowPattern)?.[0];
  const readmeProviderRow = readmeBlock.match(providerRowPattern)?.[0];
  assert.ok(generatedProviderRow, "generated docs must contain the /provider row");
  assert.equal(readmeProviderRow, generatedProviderRow, "README /provider row must match the generated row byte-for-byte");
  for (const row of [generatedProviderRow, readmeProviderRow]) {
    assert.match(row, /OpenRouter Stable/);
    assert.match(row, /Kimi Code Abo Preview/);
    assert.match(row, /Anthropic \/ Claude-Abo Coming soon/);
    assert.doesNotMatch(row, /Kimi[^;]*Stable/);
  }
  assert.match(generated, /`\/panel`/);
  assert.match(generated, /`\/resume`/);
  assert.match(generated, /`\/ssh`/);
  assert.match(generated, /chat \[new\\\|list\\\|open\\\|search\\\|rename\\\|fork\\\|delete\]/);
  assert.match(generated, /ORCODE\.md/);
});

test("README states the real platform shell defaults and image-picker boundary", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(
    readme,
    /Windows[\s\S]{0,240}powershell\.exe[\s\S]{0,120}-NoProfile[\s\S]{0,120}-NonInteractive[\s\S]{0,120}-Command/i,
  );
  assert.match(
    readme,
    /ORCODE_SHELL[\s\S]{0,300}ROUTERCODE_SHELL[\s\S]{0,160}(?:compatibility|Kompatibilität)[\s-]*(?:fallback|Fallback)/,
  );
  assert.doesNotMatch(readme, /POSIX-compatible shell[^.]*Windows/i);
  assert.doesNotMatch(readme, /\/bin\/sh -c`? by default on every platform/i);
  assert.match(
    readme,
    /native file picker[\s\S]{0,180}macOS[\s\S]{0,180}Windows(?: and| und) Linux[\s\S]{0,180}\/image <path>/i,
  );
});
