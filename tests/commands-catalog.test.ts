import assert from "node:assert/strict";
import test from "node:test";
import {
  commandTokenIsExact,
  rankSlashCommands,
} from "../src/command-catalog.js";

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
