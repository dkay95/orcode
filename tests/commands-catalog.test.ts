import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  COMMAND_CATALOG,
  COMMAND_TREE,
  CROSS_RUN_ACTIVE_COMMAND_NOTICE,
  CROSS_RUN_ACTIVE_MESSAGE_NOTICE,
  RETIRED_SLASH_COMMANDS,
  commandAllowedDuringCrossRun,
  commandTokenIsExact,
  commandTreeLevel,
  resolveSlashCommand,
  retiredSlashCommand,
  searchCommandMenuCatalog,
  searchCommands,
} from "../src/command-catalog.js";
import {
  SETTINGS_CATEGORY_IDS,
  resolveSettingsCategory,
  settingsCategoryLabel,
} from "../src/settings-registry.js";

interface TestCatalogEntry {
  name: string;
  usage: string;
  description: string;
  aliases?: readonly string[];
  acceptsArguments?: boolean;
  handlerId: string;
}

test("the flat catalog carries a description for every command", () => {
  assert.ok(COMMAND_CATALOG.length >= 15);
  assert.ok(COMMAND_CATALOG.every((command) => command.description.length > 10));
});

// FIX-15 (command-IA, ratified): the group labels are Settings' own
// vocabulary now. The audit found two taxonomies for one product — the
// palette said "Safety" where Settings said "Approvals & Costs", "Model"
// where Settings said "Models" — so a reader had to learn the product
// twice. These pins move DELIBERATELY: they still assert exactly six
// groups in one fixed order, which is what they exist to protect.
test("the recursive command tree presents the six approved English groups in order", () => {
  assert.deepEqual(
    COMMAND_TREE.map((node) => node.kind === "branch" ? node.name : node.name),
    ["Models", "Chat", "Workspace", "Accounts", "Approvals & Costs", "System"],
  );
  assert.deepEqual(
    commandTreeLevel([]).map((node) => node.name),
    ["Models", "Chat", "Workspace", "Accounts", "Approvals & Costs", "System"],
  );
});

test("the catalog owns the German branch copy and the ordered co shortcut", () => {
  assert.deepEqual(
    COMMAND_TREE.map((node) => [node.name, node.desktopDescription]),
    [
      ["Models", "Modelle und Denken"],
      ["Chat", "Unterhaltungen starten, wechseln und gestalten"],
      ["Workspace", "In diesem Ordner arbeiten"],
      ["Accounts", "Anbieter und Konten verwalten"],
      ["Approvals & Costs", "Freigaben festlegen und Ausgaben begrenzen"],
      ["System", "Status prüfen, Einstellungen ändern oder Orcode beenden"],
    ],
  );

  type SearchHint = { readonly query: string; readonly order: number };
  const collect = (nodes: readonly unknown[]): Array<{ readonly name: string; readonly hint: SearchHint }> =>
    nodes.flatMap((candidate) => {
      const node = candidate as {
        readonly name: string;
        readonly menuSearch?: readonly SearchHint[];
        readonly children?: readonly unknown[];
      };
      return [
        ...(node.menuSearch ?? []).map((hint) => ({ name: node.name, hint })),
        ...collect(node.children ?? []),
      ];
    });
  assert.deepEqual(
    collect(COMMAND_TREE)
      .filter(({ hint }) => hint.query === "co")
      .sort((left, right) => left.hint.order - right.hint.order)
      .map(({ name }) => `/${name}`),
    ["/compress", "/context", "/cost", "/cross"],
  );
});

test("provider setup is one catalog-owned runnable quick action", () => {
  const matches = searchCommandMenuCatalog("provider setup");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.kind, "command");
  if (matches[0]?.kind !== "command") return;
  assert.equal(matches[0].entry.handlerId, "provider");
  assert.equal(matches[0].entry.name, "provider setup");
  assert.equal(matches[0].entry.usage, "/provider setup");
  assert.equal(matches[0].entry.acceptsArguments, false);

  const canonical = COMMAND_CATALOG.find(({ handlerId }) => handlerId === "provider");
  assert.equal(canonical?.name, "provider");
  assert.equal(canonical && "acceptsArguments" in canonical ? canonical.acceptsArguments : undefined, true);
});

test("every shared group label is spelled exactly as Settings spells it, and no description merely restates its label", () => {
  // The one-vocabulary rule, asserted rather than merely described: every
  // palette group whose territory Settings also owns carries Settings' own
  // label, character for character, read from the live registry — so a
  // future rename on either side has to be made on both.
  const settingsLabels = new Set(
    SETTINGS_CATEGORY_IDS.map((id) => settingsCategoryLabel(id)),
  );
  assert.deepEqual(
    COMMAND_TREE.map((node) => node.name).filter((name) => settingsLabels.has(name)),
    ["Models", "Accounts", "Approvals & Costs"],
  );
  // Chat, Workspace and System name territory Settings has no page for; they
  // are the only groups allowed to be absent from that set.
  assert.deepEqual(
    COMMAND_TREE.map((node) => node.name).filter((name) => !settingsLabels.has(name)),
    ["Chat", "Workspace", "System"],
  );
  // A description that is just the label again — "Chat · Manage chats",
  // "System · Manage orcode" — tells a reader nothing they did not already
  // read one column to the left. Both are rewritten to say what the group
  // lets you DECIDE; the renamed Approvals & Costs group could not keep
  // "Approvals and limits" for the same reason.
  assert.deepEqual(
    COMMAND_TREE.map((node) => [node.name, node.description]),
    [
      ["Models", "Models and thinking"],
      ["Chat", "Start, switch, and shape the conversation you are in"],
      ["Workspace", "Work in this folder"],
      ["Accounts", "Providers and accounts"],
      ["Approvals & Costs", "Decide what runs without asking, and cap what it may spend"],
      ["System", "Check status, change settings, or leave orcode"],
    ],
  );
});

test("the tree itself owns every approved group-to-command sequence", () => {
  assert.deepEqual(
    COMMAND_TREE.map((node) => ({
      name: node.name,
      children: node.kind === "branch" ? node.children.map((child) => child.name) : [],
    })),
    [
      // FIX-15 moves, each one deliberate: `/fallback` chooses models (it is
      // not a provider setting, and its old home made it collide by name with
      // `/provider fallbacks`); `/compact` acts on THIS chat's window, beside
      // `/context`; `/image` and `/whisper` produce message content, not
      // folder work; `/verify` gives up the top row of Workspace to the
      // commands actually reached after a run.
      { name: "Models", children: ["model", "fallback", "think", "compress", "cross", "panel", "architect"] },
      { name: "Chat", children: ["new", "fork", "chat", "history", "context", "compact", "goal", "checkpoint", "image", "whisper", "export", "clear"] },
      { name: "Workspace", children: ["diff", "undo", "recover", "verify", "init", "folder", "ssh", "web"] },
      { name: "Accounts", children: ["provider", "key", "balance", "models"] },
      { name: "Approvals & Costs", children: ["allow", "budget", "max-cost", "steps", "cost"] },
      { name: "System", children: ["settings", "config", "status", "help", "quit"] },
    ],
  );
  assert.deepEqual(
    commandTreeLevel(["Models"]).map((node) => node.name),
    ["model", "fallback", "think", "compress", "cross", "panel", "architect"],
  );
  assert.deepEqual(
    commandTreeLevel(["Workspace"]).map((node) => node.name),
    ["diff", "undo", "recover", "verify", "init", "folder", "ssh", "web"],
  );
});

// ---------------------------------------------------------------------------
// FIX-2 (audit 2026-08-28): `/resume` used to mean crash triage while every
// peer CLI uses it for "resume a conversation". The triage command is now
// `/recover`; `/resume` is an ALIAS of the chats picker — one mechanism, the
// alias resolves to the very same handler, never a second implementation.
// ---------------------------------------------------------------------------

test("/resume resolves to the chats picker, never to interrupted-run triage", () => {
  const resumed = resolveSlashCommand("/resume");
  assert.equal(resumed?.handlerId, "chat");
  assert.deepEqual([...(resumed?.args ?? [])], []);
  assert.equal(resumed?.handlerId, resolveSlashCommand("/chats")?.handlerId);
  assert.equal(resumed?.handlerId, resolveSlashCommand("/chat")?.handlerId);
  const chat = COMMAND_CATALOG.find((entry) => entry.handlerId === "chat");
  assert.deepEqual([...(chat?.aliases ?? [])], ["chats", "switch", "resume"]);
});

test("/recover carries the interrupted-run triage the old /resume had, unchanged", () => {
  const recover = resolveSlashCommand("/recover");
  assert.equal(recover?.handlerId, "recover");
  for (const sub of ["continue", "undo", "discard"]) {
    const resolved = resolveSlashCommand(`/recover ${sub}`);
    assert.equal(resolved?.handlerId, "recover");
    assert.deepEqual([...(resolved?.args ?? [])], [sub]);
  }
  const entry = COMMAND_CATALOG.find((command) => command.handlerId === "recover");
  assert.equal(entry?.name, "recover");
  assert.equal(entry?.usage, "/recover [continue|undo|discard]");
  assert.equal(
    entry?.description,
    "Check, continue, undo, or discard an interrupted previous run",
  );
  assert.equal(
    COMMAND_CATALOG.some((command) => command.name === "resume"),
    false,
    "no command may be NAMED resume any more — it exists only as the chats alias",
  );
});

test("searching for resume offers the chats picker, not the triage command", () => {
  const [first] = searchCommands("resume");
  assert.equal(first?.handlerId, "chat");
});

// ---------------------------------------------------------------------------
// FIX-15 (command-IA, ratified): `cross` used to hang under a `collab`
// umbrella that owned no command of its own. The umbrella cost every leaf a
// second token in `/help` and the README ("collab umbrella pollutes /help",
// audit §6) and forced tui.ts to special-case this one branch back to
// `/cross`. `cross` is the canonical prefix now and `collab cross` is its
// compatibility ALIAS — one mechanism, the same nodes, no second subtree.
// The assertions below moved from "collab is the canonical parent" to
// "collab is only an alias" deliberately; they still pin exactly one
// spelling per row, which is what they were written to protect.
// ---------------------------------------------------------------------------

test("Cross has one canonical subtree and one whole-path compatibility alias", () => {
  const model = COMMAND_TREE.find((node) => node.name === "Models");
  assert.ok(model?.kind === "branch");
  assert.equal(
    model.children.some((node) => (node.name as string) === "collab"),
    false,
    "the collab umbrella is retired — it survives only as an alias",
  );
  const cross = model.children.find((node) => node.name === "cross");
  assert.ok(cross?.kind === "branch");
  assert.deepEqual(cross.aliases, ["collab cross"]);
  // The command finder shows this description while browsing to the branch
  // itself (see projectRow in src/ui/command-menu.ts) — it never reaches the
  // flat catalog or README docs, so nothing else pins its wording.
  assert.equal(cross.description, "Coding and review model for exactly one task");
  assert.deepEqual(
    cross.children.map((node) => node.name),
    ["run", "models", "swap", "status", "stop", "off"],
  );
  assert.deepEqual(
    cross.children.map((node) => node.kind === "command" ? node.handlerId : null),
    [
      "collab-cross-run",
      "collab-cross-models",
      "collab-cross-swap",
      "collab-cross-status",
      "collab-cross-stop",
      "collab-cross-off",
    ],
  );

  // Both spellings land on the CANONICAL path, so nothing downstream can
  // tell which one was typed.
  assert.deepEqual(resolveSlashCommand("/cross"), {
    command: cross,
    handlerId: "collab-cross",
    matchedPath: ["cross"],
    args: [],
  });
  assert.deepEqual(resolveSlashCommand("/collab cross"), {
    command: cross,
    handlerId: "collab-cross",
    matchedPath: ["cross"],
    args: [],
  });
  // The retired umbrella is not a command on its own.
  assert.equal(resolveSlashCommand("/collab"), undefined);

  for (const child of cross.children) {
    assert.equal(child.kind, "command");
    const acceptsArguments = "acceptsArguments" in child && child.acceptsArguments === true;
    const suffix = acceptsArguments ? " extra task" : "";
    const canonical = resolveSlashCommand(`/cross ${child.name}${suffix}`);
    const alias = resolveSlashCommand(`/collab cross ${child.name}${suffix}`);
    assert.ok(canonical);
    assert.deepEqual(alias, canonical);
    assert.deepEqual(canonical.matchedPath, ["cross", child.name]);
    assert.deepEqual(canonical.args, acceptsArguments ? ["extra", "task"] : []);
  }
});

test("the retired collab prefix adds no duplicate flat catalog, browse, help, or docs rows", () => {
  const cross = COMMAND_CATALOG.filter((entry) => entry.name.startsWith("cross "));
  assert.deepEqual(cross.map((entry) => entry.name), [
    "cross run",
    "cross models",
    "cross swap",
    "cross status",
    "cross stop",
    "cross off",
  ]);
  assert.equal(COMMAND_CATALOG.some((entry) => entry.name.startsWith("collab ")), false);
  assert.deepEqual(
    commandTreeLevel(["Models", "cross"]).map((node) => node.name),
    ["run", "models", "swap", "status", "stop", "off"],
  );
  // The compatibility alias is a whole path, so browsing it reaches the very
  // same children instead of a second, parallel level.
  assert.deepEqual(
    commandTreeLevel(["collab", "cross"]).map((node) => node.name),
    ["run", "models", "swap", "status", "stop", "off"],
  );
  // The search path replaces the old regex-special-cased "cross" completion:
  // it reaches the same nested leaves through their ordinary aliases, with
  // no bespoke branch-shaped handling required.
  assert.deepEqual(
    searchCommands("collab cross mo").map((entry) => entry.name),
    ["cross models"],
  );
  assert.deepEqual(
    searchCommands("cross s").map((entry) => entry.name),
    ["cross swap", "cross status", "cross stop"],
  );
});

test("the recursive command catalog owns every canonical token, alias, and handler id", async () => {
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
    matchedPath: readonly string[];
    args: readonly string[];
  } | undefined;
  for (const entry of entries) {
    for (const token of [entry.name, ...(entry.aliases ?? [])]) {
      const args = entry.acceptsArguments ? ["ignored"] : [];
      assert.deepEqual(resolveCommand(`/${token}${args.length ? " ignored" : ""}`), {
        command: entry,
        handlerId: entry.handlerId,
        matchedPath: entry.name.split(" "),
        args,
      });
    }
  }
});

test("slash aliases resolve only complete tokens and branch labels never resolve as handlers", () => {
  assert.equal(resolveSlashCommand("/approval-mode"), undefined);
  assert.equal(resolveSlashCommand("/permissionset"), undefined);
  assert.equal(resolveSlashCommand("/Accounts status"), undefined);
});

// FIX-15 moved this pin DELIBERATELY. It was written after a bug that gave
// Settings TWO catalog rows, and "one row, one handler" is still exactly
// what it protects. What it may no longer claim is "no aliases": the audit
// listed theme among the doors an owner looks for and cannot find, so
// `/appearance` and `/theme` are aliases — and an alias token IS a category
// name (`resolveSettingsCategory`), so they resolve to the same handler and
// the same lookup the `/settings <category>` argument uses. One mechanism,
// still one row.
test("settings has one canonical catalog token, one handler, and aliases that are category names", () => {
  const settingsEntries = COMMAND_CATALOG.filter(
    (entry) => entry.handlerId === "settings",
  );
  assert.deepEqual(settingsEntries, [{
    name: "settings",
    handlerId: "settings",
    usage: "/settings [models|accounts|approvals|tools|appearance]",
    description: "Open guided settings in full screen, at a category if you name one",
    desktopDescription: "Einstellungen öffnen",
    kind: "command",
    group: "system",
    aliases: ["appearance", "theme"],
    acceptsArguments: true,
  }]);
  assert.deepEqual(resolveSlashCommand("settings"), {
    command: settingsEntries[0],
    handlerId: "settings",
    matchedPath: ["settings"],
    args: [],
  });
  // Every alias is a real category token, never a bare synonym that would
  // need its own branch somewhere to mean anything.
  for (const alias of settingsEntries[0]!.aliases!) {
    assert.equal(resolveSettingsCategory(alias), "appearance", alias);
    assert.equal(resolveSlashCommand(`/${alias}`)?.handlerId, "settings");
  }
  // Every category the registry defines is reachable by its own id.
  for (const id of SETTINGS_CATEGORY_IDS) {
    assert.equal(resolveSettingsCategory(id), id);
  }

  const settingsSearch = searchCommands("settings").filter((entry) => entry.name === "settings");
  assert.equal(settingsSearch.length, 1);

  const tokensForSettings = COMMAND_CATALOG.flatMap((entry) => [
    { token: entry.name, handlerId: entry.handlerId },
    ...(("aliases" in entry ? entry.aliases : []) ?? []).map((token) => ({
      token,
      handlerId: entry.handlerId,
    })),
  ]).filter((entry) => entry.handlerId === "settings");
  assert.deepEqual(tokensForSettings, [
    { token: "settings", handlerId: "settings" },
    { token: "appearance", handlerId: "settings" },
    { token: "theme", handlerId: "settings" },
  ]);
});

// ---------------------------------------------------------------------------
// FIX-15: `/reconnect` is retired. Reconnecting an account is
// `/provider reconnect <provider>`; a second top-level door onto the same
// mechanism is the very defect the command-IA audit named. The token still
// works — it is a SHIM that says once where it went, then runs the surviving
// command — but it is no longer a command in its own right, so it must be
// absent from the catalog, the palette, `/help` and the README.
// ---------------------------------------------------------------------------

test("the retired /reconnect is a shim, not a catalog row", () => {
  assert.equal(resolveSlashCommand("/reconnect"), undefined);
  assert.equal(COMMAND_CATALOG.some((entry) => entry.name === "reconnect"), false);
  assert.equal(searchCommands("reconnect").length, 0);
  const shim = retiredSlashCommand("/reconnect");
  assert.equal(shim?.replacement, "/provider reconnect openrouter");
  assert.match(shim?.notice ?? "", /\/provider reconnect openrouter/);
  // The shim's replacement must itself be a live command — a retired token
  // may never point at another dead end.
  assert.equal(resolveSlashCommand(shim!.replacement)?.handlerId, "provider");
  // A live command is never treated as retired.
  assert.equal(retiredSlashCommand("/provider reconnect openrouter"), undefined);
  assert.equal(retiredSlashCommand("/recover"), undefined);
});

// Fix round 1, F3/F5/F7: a table keyed by TYPED TEXT must not inherit
// `constructor`/`__proto__`/`toString` from Object.prototype. It used to:
// `/constructor` crashed the dispatcher with a raw TypeError and
// `/settings constructor` opened Settings with `Object` as its category.
// The class is fixed at the source (`lookupTable`, utils.ts — null prototype
// AND a `| undefined` value type so a miss cannot be typed as a hit); these
// pin the behaviour an owner sees.
test("prototype keys are unknown commands, never a crash and never a phantom entry", () => {
  for (const key of ["constructor", "__proto__", "hasOwnProperty", "toString", "valueOf", "prototype"]) {
    assert.equal(resolveSlashCommand(`/${key}`), undefined, key);
    assert.equal(retiredSlashCommand(`/${key}`), undefined, key);
    assert.equal(resolveSettingsCategory(key), undefined, key);
  }
  // The lookup itself, not just its callers: reading a prototype key off the
  // live table yields nothing at all.
  for (const key of ["constructor", "__proto__", "toString"]) {
    assert.equal(RETIRED_SLASH_COMMANDS[key], undefined, key);
  }
  assert.equal(Object.getPrototypeOf(RETIRED_SLASH_COMMANDS), null);
});

test("no retired token may shadow a live command name or alias", () => {
  // F7: the shim runs BEFORE resolveSlashCommand, so a retired key that
  // collided with a live token would silently swallow it. Asserted over the
  // whole table rather than the one entry that exists today.
  //
  // FIX-14 ticket 16 (FIX-15's own recorded residual: "narrower than the
  // rule it guards"). `retiredSlashCommand` matches on the FIRST TOKEN of
  // the input alone, but this invariant compared retired keys against WHOLE
  // names and aliases. The blind spot was precisely the multi-token
  // compatibility path: `collab cross swap` is a live alias whose first
  // token is `collab`, and `live.has("collab")` is false — so retiring
  // `collab` would have passed this guard while silently swallowing every
  // `/collab …` the alias exists to keep working. The set is built from
  // first tokens now, which is the rule the shim actually applies.
  const live = new Set(COMMAND_CATALOG.flatMap((entry) => [
    entry.name,
    ...("aliases" in entry ? entry.aliases : []),
  ].map((identifier) => identifier.toLowerCase().split(/\s+/)[0]!)));
  // The guard must be able to see the case it was blind to.
  assert.ok(live.has("collab"), "the compatibility prefix must be in the live first-token set");
  for (const token of Object.keys(RETIRED_SLASH_COMMANDS)) {
    assert.equal(live.has(token), false, `retired /${token} shadows a live command`);
    assert.equal(resolveSlashCommand(`/${token}`), undefined, token);
    // And every replacement must reach a live command — a retired token may
    // never point at another dead end.
    const shim = retiredSlashCommand(`/${token}`)!;
    assert.ok(resolveSlashCommand(shim.replacement), `retired /${token} points nowhere`);
  }
});

test("provider catalog, search, help, and generated docs expose the one flat dispatcher", () => {
  const provider = searchCommands("provider")[0];
  const providerDefinition = COMMAND_CATALOG.find((entry) => entry.name === "provider");
  assert.equal(provider?.name, "provider");
  assert.equal(providerDefinition?.handlerId, "provider");
  assert.match(provider?.usage ?? "", /setup/);
  assert.match(provider?.usage ?? "", /connect/);
  assert.match(provider?.usage ?? "", /disconnect/);
  assert.match(provider?.usage ?? "", /logout/);
  // FIX-9 (internal leaks): the description used to be a per-provider
  // maturity/billing dump ("OpenRouter Stable; Kimi Code subscription
  // Preview (membership key); Anthropic … not a direct backend"). That
  // state belongs to `/provider status` and Settings' Accounts rows, which
  // render it live; a catalog description says what the COMMAND does. The
  // per-provider maturity/billing wording stays asserted where it is
  // actually rendered (commands.test.ts / settings-registry.test.ts), and
  // FIX-12's no-"coming soon" rule still holds here.
  assert.match(provider?.description ?? "", /set up/i);
  assert.match(provider?.description ?? "", /connect/i);
  assert.doesNotMatch(provider?.description ?? "", /Stable|Preview|Coming soon/i);
  assert.doesNotMatch(provider?.usage ?? "", /kimi/i);
});

test("exact command detection ignores arguments", () => {
  const think = COMMAND_CATALOG.find((entry) => entry.name === "think")!;
  assert.equal(commandTokenIsExact("/think high", think), true);
  assert.equal(commandTokenIsExact("/th", think), false);
});

test("interactive approval commands expose their aliases", () => {
  const approval = COMMAND_CATALOG.find((entry) => entry.name === "allow")!;
  assert.equal(commandTokenIsExact("/allow", approval), true);
  assert.equal(approval.name, "allow");
});

// --- Phase 4: one global actionable command finder (E-STRUCT-02) -----------

test("a bare prefix returns executable leaves from anywhere in the tree on the first keystroke — the cutover criterion", () => {
  // Under the old root-level-only filter every one of these was a silent
  // 0-row dead end (DESIGN-IS-2026-08-26/01-evidence.md#e-struct-02): "/mo"
  // even matched the "Model" *branch* label instead of any command. Each
  // top match below comes from tier 2 ("prefix-of-name"); ties inside a
  // tier keep the tree's own definition order, which is why e.g. "compress"
  // (defined before "cost" and "config") leads for "co".
  assert.equal(searchCommands("co")[0]?.name, "compress");
  assert.equal(searchCommands("set")[0]?.name, "settings");
  assert.equal(searchCommands("pro")[0]?.name, "provider");
  assert.equal(searchCommands("mo")[0]?.name, "model");

  // Full ranked sets, pinned as a regression check on the tier algorithm.
  //
  // FIX-14 ticket 20: the six Cross rows used to sit at tier 2 here, ABOVE
  // /context, /compact, /cost and /config — commands whose own names really
  // do begin with "co" — purely because the RETIRED `collab` umbrella left
  // them the alias "collab cross …". A compatibility-prefix alias (one that
  // is the canonical path wearing a retired prefix) is capped at tier 1
  // now, so the old spelling stays findable without outranking live names.
  assert.deepEqual(searchCommands("co").map((entry) => entry.name), [
    "compress",       // tier 2: name starts with "co"
    "context",        // tier 2: name starts with "co" (Chat group, Phase 13)
    "compact",        // tier 2: name starts with "co" (Chat group, FIX-15)
    "cost",           // tier 2: name starts with "co"
    "config",         // tier 2: name starts with "co"
    "cross run",      // tier 1: only the retired-umbrella alias
    "cross models",   // "collab cross …" starts with "co", and a
    "cross swap",     // compatibility prefix never reaches tier 2
    "cross status",
    "cross stop",
    "cross off",
    "recover",        // tier 0: "recover" contains "co" (Workspace group)
    "max-cost",       // tier 0: "max-cost" contains "co"
  ]);
  assert.deepEqual(searchCommands("set").map((entry) => entry.name), ["settings"]);
  assert.deepEqual(searchCommands("pro").map((entry) => entry.name), [
    "provider", // tier 2: name starts with "pro"
    "allow",    // tier 0: alias "approval" contains "pro"
  ]);
  assert.deepEqual(searchCommands("mo").map((entry) => entry.name), [
    "model",        // tier 2: name starts with "mo"
    "models",       // tier 2: name starts with "mo"
    "cross models", // tier 1: its "models" token starts with "mo", but
                    // neither "cross models" nor its alias does, so it
                    // ranks below the tier-2 matches
  ]);
});

test("an exact command name or alias always ranks first, even over a shorter prefix match", () => {
  const matches = searchCommands("model");
  assert.deepEqual(matches.map((entry) => entry.name), [
    "model",        // tier 3: exact
    "models",       // tier 2: prefix
    "cross models", // tier 1: path-token prefix
  ]);
});

test("FIX-14 ticket 20: a compatibility-prefix alias never outranks a live command name", () => {
  // "collab cross swap" is `/cross swap`'s canonical path wearing the
  // RETIRED `collab` prefix — the only reason a Cross row matches "co" at
  // all. It must stay findable (tier 1, through its own tokens) and it must
  // not sit at the tier reserved for names that genuinely begin that way.
  const byName = new Map(searchCommands("co").map((entry, index) => [entry.name, index]));
  for (const live of ["compress", "context", "compact", "cost", "config"]) {
    for (const compat of ["cross run", "cross swap", "cross off"]) {
      assert.ok(
        byName.get(live)! < byName.get(compat)!,
        `${live} must rank above ${compat} for "co"`,
      );
    }
  }

  // A plain synonym is NOT a compatibility-prefix alias and keeps tier 2:
  // "chats" is `/chat`'s own alias, not a retired path prefix.
  assert.equal(searchCommands("chats")[0]?.name, "chat");

  // Typing a retired path IN FULL is deliberate and unambiguous — exact
  // still wins outright, so nothing became unreachable.
  assert.equal(searchCommands("collab cross swap")[0]?.name, "cross swap");
});

test("group and branch labels are never searchable — only the commands they contain are", () => {
  assert.deepEqual(searchCommands("accounts"), []);
  assert.deepEqual(searchCommands("workspace"), []);
  assert.deepEqual(searchCommands("system"), []);
});

test("search results are always executable leaves, never a browse-only group", () => {
  for (const query of ["mo", "co", "pro", "set", "cross", "collab", "th", "a"]) {
    for (const entry of searchCommands(query)) {
      assert.equal(entry.kind, "command", `query "${query}" returned a non-command entry`);
    }
  }
});

test("every leaf and alias in the real catalog is findable by searching its own exact text", () => {
  // No hand-maintained list: this walks the live COMMAND_CATALOG, so a
  // future command or alias is covered automatically.
  for (const entry of COMMAND_CATALOG) {
    const tokens = [entry.name, ...("aliases" in entry ? entry.aliases : [])];
    for (const token of tokens) {
      const matches = searchCommands(token);
      assert.ok(
        matches.some((match) => match.handlerId === entry.handlerId),
        `searching "${token}" did not surface ${entry.handlerId}`,
      );
    }
  }
});

test("search ranks partial command names and aliases", () => {
  // "settings" joins "think" here through its FIX-15 `theme` alias — an
  // alias is a search key by design, which is the whole point of adding one.
  assert.deepEqual(searchCommands("th").map((command) => command.name), ["think", "settings"]);
  assert.equal(searchCommands("perm")[0]?.name, "allow");
  assert.equal(searchCommands("cred")[0]?.name, "balance");
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
  const startMarker = "<!-- orcode:command-docs:start -->";
  const endMarker = "<!-- orcode:command-docs:end -->";
  const countMarker = (marker: string): number => readme.split(marker).length - 1;
  assert.equal(countMarker(startMarker), 1, "README must contain exactly one command-docs start marker");
  assert.equal(countMarker(endMarker), 1, "README must contain exactly one command-docs end marker");
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, "README must carry the command-docs markers in order");
  const readmeBlock = readme.slice(start, end + endMarker.length);
  const providerRowPattern = /^\| `\/provider` \|[^\n]*$/m;
  const generatedProviderRow = generated.match(providerRowPattern)?.[0];
  const readmeProviderRow = readmeBlock.match(providerRowPattern)?.[0];
  assert.ok(generatedProviderRow, "generated docs must contain the /provider row");
  assert.equal(readmeProviderRow, generatedProviderRow, "README /provider row must match the generated row byte-for-byte");
  for (const row of [generatedProviderRow, readmeProviderRow]) {
    // FIX-9 (internal leaks): the /provider row's description is a command
    // description now, not a per-provider maturity/billing dump — that
    // state is rendered live by `/provider status` and Settings' Accounts
    // rows, where README cannot go stale against it.
    assert.match(row, /Set up, connect, check, or disconnect provider accounts/);
    assert.doesNotMatch(row, /Stable|Preview|Coming soon/i);
  }
  assert.match(generated, /`\/panel`/);
  assert.match(generated, /`\/recover`/);
  assert.match(generated, /`\/ssh`/);
  for (const child of ["run", "models", "swap", "status", "stop", "off"]) {
    const canonical = `| \`/cross ${child}\` | \`/collab cross ${child}\``;
    assert.equal(generated.split(canonical).length - 1, 1);
    assert.equal(readmeBlock.split(canonical).length - 1, 1);
  }
  assert.equal(generated.match(/^\| `\/collab /gm), null, "the alias must not create duplicate rows");
  const settingsRow = "| `/settings` | `/appearance`, `/theme` | `/settings [models\\|accounts\\|approvals\\|tools\\|appearance]` | Open guided settings in full screen, at a category if you name one |";
  assert.equal(generated.split(settingsRow).length - 1, 1);
  assert.equal(readmeBlock.split(settingsRow).length - 1, 1);
  assert.match(generated, /chat \[new\\\|list\\\|open\\\|search\\\|rename\\\|fork\\\|delete\]/);
  assert.match(generated, /ORCODE\.md/);
  for (const command of COMMAND_CATALOG) {
    assert.equal(
      (generated.match(new RegExp("^\\\\| `/" + command.name + "`", "m")) ?? []).length,
      1,
      `generated docs must contain /${command.name} exactly once`,
    );
  }
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

// ---------------------------------------------------------------------------
// G4 / l5: one list and one wording for what a Cross run leaves reachable.
//
// The G3 round fixed three of the four sites; the fourth was
// `handleSlashCommand`'s own gate, which could not import `cli.ts` and so kept
// an inline four-name chain and a verbatim copy of the sentence. The list
// lives in `command-catalog.ts` now — a module every consumer already imports
// — and this tripwire is what keeps a fifth copy from growing back.
// ---------------------------------------------------------------------------

test("the Cross-run notices exist exactly once in the source", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = new URL("../src/", import.meta.url).pathname;
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  await walk(root);

  for (const sentence of [
    CROSS_RUN_ACTIVE_COMMAND_NOTICE,
    CROSS_RUN_ACTIVE_MESSAGE_NOTICE,
  ]) {
    const holders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes(`"${sentence}"`)) holders.push(file.slice(root.length));
    }
    assert.deepEqual(
      holders,
      ["command-catalog.ts"],
      `the sentence must be written once; it is written in ${holders.join(", ")}`,
    );
  }

  // And the membership test is the list's, never a chain of `!==`.
  assert.equal(commandAllowedDuringCrossRun("collab-cross-stop"), true);
  assert.equal(commandAllowedDuringCrossRun("quit"), true);
  assert.equal(commandAllowedDuringCrossRun("diff"), false);
  const commands = await readFile(new URL("../src/commands.ts", import.meta.url), "utf8");
  assert.match(
    commands,
    /context\.crossRunActive\?\.\(\) && !commandAllowedDuringCrossRun\(command\)/,
    "the shared dispatcher gates on the shared list",
  );
});
