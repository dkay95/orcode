import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isEntrypoint } from "../src/cli.js";

const MODULE_URL = pathToFileURL("/opt/routercode/dist/cli.js").href;

test("a direct invocation is recognised as the entrypoint", () => {
  assert.equal(isEntrypoint(MODULE_URL, "/opt/routercode/dist/cli.js"), true);
});

test("a symlinked bin is recognised as the entrypoint", () => {
  // `~/.local/bin/routercode` is a symlink to `dist/cli.js`. Node resolves the
  // module URL through the link but leaves argv[1] on the link itself, so the
  // naive comparison fails and main() never runs — the CLI just exits silently.
  const resolve = (path: string): string =>
    path === "/home/u/.local/bin/routercode"
      ? "/opt/routercode/dist/cli.js"
      : path;
  assert.equal(
    isEntrypoint(MODULE_URL, "/home/u/.local/bin/routercode", resolve),
    true,
  );
});

test("an unrelated entrypoint is not mistaken for this module", () => {
  // A test importing pure helpers from cli.ts must not start the dashboard.
  assert.equal(isEntrypoint(MODULE_URL, "/opt/other/tool.js", (p) => p), false);
});

test("a missing argv[1] is not an entrypoint", () => {
  assert.equal(isEntrypoint(MODULE_URL, undefined), false);
});

test("an unresolvable argv[1] does not throw", () => {
  const resolve = (): string => {
    throw new Error("ENOENT");
  };
  assert.doesNotThrow(() => isEntrypoint(MODULE_URL, "/nope", resolve));
});
