import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_CATALOG, resolveSlashCommand } from "../src/command-catalog.js";
import { resolveCliCommandName } from "../src/cli.js";

test("every actionable catalog leaf has one CLI-dispatchable handler", () => {
  const handlerIds = COMMAND_CATALOG.map((command) => command.handlerId);
  assert.equal(new Set(handlerIds).size, handlerIds.length);

  for (const command of COMMAND_CATALOG) {
    assert.equal(resolveCliCommandName(`/${command.name}`), command.handlerId);
  }
});

test("unknown and branch-only command input cannot resolve to a leaf handler", () => {
  assert.equal(resolveSlashCommand("/unbekannt arg"), undefined);
  assert.equal(resolveSlashCommand("/System status"), undefined);
  assert.equal(resolveCliCommandName("/unbekannt arg"), "unbekannt");
  assert.equal(resolveCliCommandName("/System status"), "system");
});
