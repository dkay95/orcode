import { lookupTable } from "./utils.js";

export interface SlashCommandDefinition {
  name: string;
  usage: string;
  description: string;
  desktopDescription?: string;
  menuSearch?: readonly CommandMenuSearchHint[];
  menuQuickActions?: readonly CommandMenuQuickAction[];
  aliases?: readonly string[];
  acceptsArguments?: boolean;
}

export interface CommandMenuSearchHint {
  readonly query: string;
  readonly order: number;
}

export interface CommandMenuQuickAction {
  readonly query: string;
  readonly args: readonly string[];
  readonly order: number;
}

/**
 * FIX-15: one vocabulary for one product. These ids are the palette groups'
 * own labels, lowercased, and they deliberately match Settings'
 * `SettingsCategoryId` (settings-registry.ts) word for word — the audit found
 * the two surfaces naming the same territory differently ("Safety" in the
 * palette, "Approvals & Costs" in Settings), which is two taxonomies for one
 * product.
 */
export type CommandGroupId =
  | "models"
  | "chat"
  | "workspace"
  | "accounts"
  | "approvals-costs"
  | "system";

export interface CommandBranchDefinition {
  readonly kind: "branch";
  readonly name: string;
  readonly description: string;
  readonly desktopDescription?: string;
  readonly menuSearch?: readonly CommandMenuSearchHint[];
  /**
   * Compatibility tokens for this branch. On a `commandPrefix` branch an
   * alias REPLACES the canonical prefix for its whole subtree, and it may be
   * several tokens long (`"collab cross"`), so a retired umbrella keeps
   * resolving without a second copy of its children anywhere.
   */
  readonly aliases?: readonly string[];
  /** Command branches add their token to descendants; presentation groups do not. */
  readonly commandPrefix?: boolean;
  /** Optional exact action for an actionable branch such as bare `cross`. */
  readonly handlerId?: string;
  readonly children: readonly CommandCatalogNode[];
}

export interface CommandLeafDefinition extends SlashCommandDefinition {
  readonly kind: "command";
  readonly handlerId: string;
  readonly group: CommandGroupId;
}

export type CommandCatalogNode = CommandBranchDefinition | CommandLeafDefinition;

/** Compatibility type for consumers that render only actionable leaves. */
export type CommandCatalogDefinition = CommandLeafDefinition;

export const COMMAND_TREE = [
  { kind: "branch", name: "Models", description: "Models and thinking", desktopDescription: "Modelle und Denken", children: [
    { kind: "command", group: "models", name: "model", handlerId: "model", usage: "/model [provider/model|current]", description: "Search, choose, or show the main model", acceptsArguments: true },
    // FIX-15: `/fallback` chooses MODELS — the chain behind the main model —
    // so it belongs beside `/model`, not in Accounts, where it read as a
    // provider setting and collided by name with `/provider fallbacks`.
    { kind: "command", group: "models", name: "fallback", handlerId: "fallback", usage: "/fallback [+<model>|-<model>|clear]", description: "Maintain the fallback model chain behind the main model", aliases: ["fallbacks"], acceptsArguments: true },
    { kind: "command", group: "models", name: "think", handlerId: "think", usage: "/think [auto|off|level|budget tokens]", description: "Control the reasoning level or thinking budget", aliases: ["reasoning"], acceptsArguments: true },
    // `/compress` is the policy (mode, model, threshold, limit) and stays a
    // MODEL choice; `/compact` runs exactly one pass with that policy's
    // summarizer, now, on this chat — so FIX-15 files it under Chat, beside
    // `/context`, which is the window it shortens.
    { kind: "command", group: "models", name: "compress", handlerId: "compress", usage: "/compress [mode|model]", description: "Interactively choose the summarizer model or set when long chats get summarized", desktopDescription: "Zusammenfassung für lange Chats einstellen", menuSearch: [{ query: "co", order: 0 }], aliases: ["compressor"], acceptsArguments: true },
    // FIX-15: `cross` is the canonical prefix now. The `collab` umbrella it
    // used to hang under owned no command of its own, yet every leaf paid for
    // it twice — once in `/help` and the README as `/collab cross …`, once in
    // tui.ts, which had to special-case this one branch back to `/cross`. The
    // umbrella survives ONLY as this branch's compatibility alias, resolving
    // to these very nodes; it is not a second subtree.
    { kind: "branch", name: "cross", description: "Coding and review model for exactly one task", desktopDescription: "Coding- und Prüfmodell für genau eine Aufgabe", menuSearch: [{ query: "co", order: 3 }], aliases: ["collab cross"], commandPrefix: true, handlerId: "collab-cross", children: [
      { kind: "command", group: "models", name: "run", handlerId: "collab-cross-run", usage: "/cross run [task]", description: "Start Cross with the given or received task", acceptsArguments: true },
      { kind: "command", group: "models", name: "models", handlerId: "collab-cross-models", usage: "/cross models", description: "Open Cross focused on choosing the coding and review models" },
      { kind: "command", group: "models", name: "swap", handlerId: "collab-cross-swap", usage: "/cross swap", description: "Atomically swap the coding and review models" },
      { kind: "command", group: "models", name: "status", handlerId: "collab-cross-status", usage: "/cross status", description: "Show the current or most recent Cross run" },
      { kind: "command", group: "models", name: "stop", handlerId: "collab-cross-stop", usage: "/cross stop", description: "Cancel the active Cross run and stop both workers" },
      { kind: "command", group: "models", name: "off", handlerId: "collab-cross-off", usage: "/cross off", description: "Turn off persistent Cross mode for this chat" },
    ] },
    { kind: "command", group: "models", name: "panel", handlerId: "panel", usage: "/panel <question> | models <a>,<b>,… | judge on|off | show <n> | use <n>", description: "Ask multiple models in parallel and compare their answers", acceptsArguments: true },
    { kind: "command", group: "models", name: "architect", handlerId: "architect", usage: "/architect [task]", description: "Plan with the main model, then execute the accepted plan with the cheaper executor model", acceptsArguments: true },
  ] },
  { kind: "branch", name: "Chat", description: "Start, switch, and shape the conversation you are in", desktopDescription: "Unterhaltungen starten, wechseln und gestalten", children: [
    { kind: "command", group: "chat", name: "new", handlerId: "new", usage: "/new [title]", description: "Start a new, separate chat in this folder", acceptsArguments: true },
    { kind: "command", group: "chat", name: "fork", handlerId: "fork", usage: "/fork [title]", description: "Fork the current chat, with its context, into a new chat", acceptsArguments: true },
    // `resume` is an alias, never a second mechanism: every peer CLI's
    // "/resume" means "resume a conversation", so the token resolves to this
    // one chats picker. Crash triage lives at `/recover` (Workspace), which is
    // what the old `/resume` actually did.
    { kind: "command", group: "chat", name: "chat", handlerId: "chat", usage: "/chat [new|list|open|search|rename|fork|delete]", description: "Search, choose, create, rename, or fork chats", aliases: ["chats", "switch", "resume"], acceptsArguments: true },
    { kind: "command", group: "chat", name: "history", handlerId: "history", usage: "/history [count]", description: "Show recent chat turns", acceptsArguments: true },
    // FIX-15: `pin` is an ALIAS of the same handler, not a second command —
    // the audit listed pinning among the doors an owner looks for and cannot
    // find. `/pin` opens the very view whose row numbers `/context pin <n>`
    // needs, and that view prints the pin syntax itself.
    { kind: "command", group: "chat", name: "context", handlerId: "context", usage: "/context [pin <n>|unpin <n>]", description: "Show the context window's composition and fill, and pin turns as never-compress", desktopDescription: "Kontextfenster anzeigen und Nachrichten anheften", menuSearch: [{ query: "co", order: 1 }], aliases: ["pin"], acceptsArguments: true },
    { kind: "command", group: "chat", name: "compact", handlerId: "compact", usage: "/compact", description: "Summarize this chat's context now, once, and report what it saved" },
    { kind: "command", group: "chat", name: "goal", handlerId: "goal", usage: "/goal [<text>|off]", description: "Set, show, or clear a persistent goal injected into every run's context", acceptsArguments: true },
    { kind: "command", group: "chat", name: "checkpoint", handlerId: "checkpoint", usage: "/checkpoint [list|new [name]|restore <id|name>]", description: "Mark a point in the chat, or reset to a mark", aliases: ["checkpoints"], acceptsArguments: true },
    // FIX-15: an image and a dictated line are message CONTENT — they go into
    // the conversation, not into the folder — so they moved out of Workspace,
    // which is about the files and the checkout.
    { kind: "command", group: "chat", name: "image", handlerId: "image", usage: "/image [path|clear]", description: "Choose an image, attach it by path, or clear attachments", aliases: ["attach"], acceptsArguments: true },
    { kind: "command", group: "chat", name: "whisper", handlerId: "whisper", usage: "/whisper", description: "Record voice input and insert it as text in the input line", aliases: ["voice"] },
    { kind: "command", group: "chat", name: "export", handlerId: "export", usage: "/export [file]", description: "Print the chat as Markdown or write it to a file", acceptsArguments: true },
    { kind: "command", group: "chat", name: "clear", handlerId: "clear", usage: "/clear", description: "Reset this chat's history and its recorded cost" },
  ] },
  { kind: "branch", name: "Workspace", description: "Work in this folder", desktopDescription: "In diesem Ordner arbeiten", children: [
    // FIX-15 ordering: what you reach for after a run leads — see the change,
    // undo it, recover from a crash — and the things you set up once
    // (`/verify` and below) follow. `/verify` held the top row while being
    // the group's least frequent command.
    { kind: "command", group: "workspace", name: "diff", handlerId: "diff", usage: "/diff", description: "Show the current git diff" },
    { kind: "command", group: "workspace", name: "undo", handlerId: "undo", usage: "/undo [--dry-run]", description: "Revert the last run's file changes", acceptsArguments: true },
    { kind: "command", group: "workspace", name: "recover", handlerId: "recover", usage: "/recover [continue|undo|discard]", description: "Check, continue, undo, or discard an interrupted previous run", acceptsArguments: true },
    { kind: "command", group: "workspace", name: "verify", handlerId: "verify", usage: "/verify [on|off|now|suggest|clear|rounds <n>|<command>]", description: "Configure verification commands to run after changes", acceptsArguments: true },
    { kind: "command", group: "workspace", name: "init", handlerId: "init", usage: "/init", description: "Create ORCODE.md in this folder" },
    { kind: "command", group: "workspace", name: "folder", handlerId: "folder", usage: "/folder [open <path>|new <path>]", description: "Change or create the workspace folder, re-rooting orcode into it", acceptsArguments: true },
    { kind: "command", group: "workspace", name: "ssh", handlerId: "ssh", usage: "/ssh [<alias>|status|off]", description: "Choose, check, or disconnect an SSH target from ~/.ssh/config", acceptsArguments: true },
    { kind: "command", group: "workspace", name: "web", handlerId: "web", usage: "/web [on|off|auto]", description: "Control the web search plugin for the main run", acceptsArguments: true },
  ] },
  { kind: "branch", name: "Accounts", description: "Providers and accounts", desktopDescription: "Anbieter und Konten verwalten", children: [
    { kind: "command", group: "accounts", name: "provider", handlerId: "provider", usage: "/provider [setup|connect|login|logout|enable|disable|disconnect|reconnect|status|models|sort|only|ignore|clear] | data allow|deny | fallbacks on|off", description: "Set up, connect, check, or disconnect provider accounts", menuQuickActions: [{ query: "provider setup", args: ["setup"], order: 0 }], acceptsArguments: true },
    { kind: "command", group: "accounts", name: "key", handlerId: "key", usage: "/key [set|replace|save|status|forget|management]", description: "Manage the OpenRouter key securely", acceptsArguments: true },
    { kind: "command", group: "accounts", name: "balance", handlerId: "balance", usage: "/balance", description: "Recheck balance and key limit", aliases: ["credits"] },
    { kind: "command", group: "accounts", name: "models", handlerId: "models", usage: "/models [search]", description: "List tool-capable OpenRouter models", acceptsArguments: true },
  ] },
  { kind: "branch", name: "Approvals & Costs", description: "Decide what runs without asking, and cap what it may spend", desktopDescription: "Freigaben festlegen und Ausgaben begrenzen", children: [
    { kind: "command", group: "approvals-costs", name: "allow", handlerId: "allow", usage: "/allow [mode|list|forget <id>|forget all]", description: "Choose approvals; list or forget remembered rules", aliases: ["approval", "approvals", "permissions"], acceptsArguments: true },
    { kind: "command", group: "approvals-costs", name: "budget", handlerId: "budget", usage: "/budget [day <USD>|total <USD>|on-exceed warn|block]", description: "Show this folder's budget or set the daily/total limit", acceptsArguments: true },
    { kind: "command", group: "approvals-costs", name: "max-cost", handlerId: "max-cost", usage: "/max-cost [USD]", description: "Set the cost limit per main-agent run", acceptsArguments: true },
    { kind: "command", group: "approvals-costs", name: "steps", handlerId: "steps", usage: "/steps [count]", description: "Set the maximum number of actions per run", acceptsArguments: true },
    { kind: "command", group: "approvals-costs", name: "cost", handlerId: "cost", usage: "/cost", description: "Show what this chat and this folder have cost", desktopDescription: "Kosten dieses Chats und Ordners anzeigen", menuSearch: [{ query: "co", order: 2 }], aliases: ["costs"] },
  ] },
  { kind: "branch", name: "System", description: "Check status, change settings, or leave orcode", desktopDescription: "Status prüfen, Einstellungen ändern oder Orcode beenden", children: [
    // FIX-15: the category argument and the `appearance`/`theme` aliases are
    // ONE mechanism — an alias token IS a category name
    // (`resolveSettingsCategory`, settings-registry.ts), so `/theme` and
    // `/settings theme` open the same page through the same lookup, and the
    // catalog still carries exactly one `/settings` row.
    { kind: "command", group: "system", name: "settings", handlerId: "settings", usage: "/settings [models|accounts|approvals|tools|appearance]", description: "Open guided settings in full screen, at a category if you name one", desktopDescription: "Einstellungen öffnen", aliases: ["appearance", "theme"], acceptsArguments: true },
    { kind: "command", group: "system", name: "config", handlerId: "config", usage: "/config", description: "Show the stored, non-secret configuration" },
    { kind: "command", group: "system", name: "status", handlerId: "status", usage: "/status", description: "Show models, modes, limits, and folder" },
    { kind: "command", group: "system", name: "help", handlerId: "help", usage: "/help", description: "Show all commands and their usage", aliases: ["?"] },
    { kind: "command", group: "system", name: "quit", handlerId: "quit", usage: "/quit", description: "Quit orcode", aliases: ["exit", "q"] },
  ] },
] as const satisfies readonly CommandCatalogNode[];

/**
 * Tokens that used to be commands of their own and are not any more. FIX-15
 * retired `/reconnect`: reconnecting an account is `/provider reconnect
 * <provider>`, and two doors onto one mechanism is exactly what the
 * command-IA audit found ("/fallback vs /provider fallback = two features one
 * name" is the same defect one row down). This is a SHIM, not a second
 * implementation — the token keeps working, says once where it went, and
 * then runs the surviving command. It deliberately does not appear in the
 * catalog, so it is absent from `/help`, the palette and the README.
 */
export const RETIRED_SLASH_COMMANDS = lookupTable<{
  readonly replacement: string;
  readonly notice: string;
}>({
  reconnect: Object.freeze({
    replacement: "/provider reconnect openrouter",
    notice: "/reconnect is now /provider reconnect openrouter — running it there.",
  }),
});

/** The retired-token shim for `input`, or `undefined` when it names a live command. */
export function retiredSlashCommand(input: string): {
  readonly replacement: string;
  readonly notice: string;
} | undefined {
  const [token] = input.trimStart().replace(/^\//, "").split(/\s+/);
  return token ? RETIRED_SLASH_COMMANDS[token.toLowerCase()] : undefined;
}

export function flattenCommandTree(
  nodes: readonly CommandCatalogNode[],
  prefixes: readonly (readonly string[])[] = [[]],
): readonly CommandLeafDefinition[] {
  return nodes.flatMap((node): readonly CommandLeafDefinition[] => {
    if (node.kind === "command") {
      const [canonicalPrefix = []] = prefixes;
      const canonicalName = [...canonicalPrefix, node.name].join(" ");
      const inheritedAliases = prefixes.slice(1).map((prefix) => [...prefix, node.name].join(" "));
      const ownAliases = (node.aliases ?? []).map((alias) => [...canonicalPrefix, alias].join(" "));
      const aliases = [...inheritedAliases, ...ownAliases];
      return [{
        ...node,
        name: canonicalName,
        ...(aliases.length > 0 ? { aliases } : {}),
      }];
    }
    if (!node.commandPrefix) return flattenCommandTree(node.children, prefixes);
    const [canonicalPrefix = []] = prefixes;
    const nextPrefixes = [
      [...canonicalPrefix, node.name],
      ...prefixes.slice(1).map((prefix) => [...prefix, node.name]),
      // A branch alias replaces the whole canonical prefix and may be several
      // tokens long, so it is split the same way the resolver splits input.
      ...(node.aliases ?? []).map((alias) => aliasTokens(alias)),
    ];
    return flattenCommandTree(node.children, nextPrefixes);
  });
}

/** Flat compatibility surface, derived exclusively from actionable tree leaves. */
type TreeLeaf<Node> = Node extends { readonly kind: "command" }
  ? Node
  : Node extends { readonly children: readonly (infer Child)[] }
    ? TreeLeaf<Child>
    : never;

type FlattenedLeaf<Leaf> = Leaf extends CommandLeafDefinition
  ? Omit<Leaf, "name" | "aliases"> & { readonly name: string; readonly desktopDescription?: string } & (
      Leaf extends { readonly aliases: infer Aliases }
        ? { readonly aliases: Aliases }
        : Leaf extends { readonly handlerId: `collab-cross-${string}` }
          ? { readonly aliases: readonly string[] }
          : Record<never, never>
    )
  : never;

export type CommandCatalogEntry = FlattenedLeaf<TreeLeaf<(typeof COMMAND_TREE)[number]>>;

export const COMMAND_CATALOG = flattenCommandTree(COMMAND_TREE) as readonly CommandCatalogEntry[];

/** A catalog leaf with quick-action arguments materialized into its command text. */
export type CommandMenuCatalogEntry = CommandLeafDefinition;

export type CommandMenuCatalogMatch =
  | { readonly kind: "command"; readonly entry: CommandMenuCatalogEntry }
  | { readonly kind: "branch"; readonly node: CommandBranchDefinition };

/**
 * Catalog-owned command-menu shortcuts, falling back to the ordinary global
 * leaf search. A shortcut is metadata on the command/branch it exposes, so
 * neither the terminal nor the Desktop shell carries a second list.
 */
export function searchCommandMenuCatalog(query: string): readonly CommandMenuCatalogMatch[] {
  const normalized = query.trim().replace(/^\//, "").toLowerCase();
  const entriesByHandler = new Map<string, CommandMenuCatalogEntry>(
    COMMAND_CATALOG.map((entry) => [entry.handlerId, entry]),
  );
  const shortcuts: Array<{ readonly order: number; readonly match: CommandMenuCatalogMatch }> = [];
  const collect = (nodes: readonly CommandCatalogNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "command") {
        for (const action of node.menuQuickActions ?? []) {
          if (action.query.trim().toLowerCase() !== normalized) continue;
          const entry = entriesByHandler.get(node.handlerId);
          if (!entry) continue;
          const suffix = action.args.join(" ");
          const name = `${entry.name} ${suffix}`;
          shortcuts.push({
            order: action.order,
            match: {
              kind: "command",
              entry: {
                ...entry,
                name,
                usage: `/${name}`,
                acceptsArguments: false,
              },
            },
          });
        }
      }
      for (const hint of node.menuSearch ?? []) {
        if (hint.query.trim().toLowerCase() !== normalized) continue;
        if (node.kind === "command") {
          const entry = entriesByHandler.get(node.handlerId);
          if (entry) shortcuts.push({ order: hint.order, match: { kind: "command", entry } });
        } else if (node.handlerId) {
          shortcuts.push({ order: hint.order, match: { kind: "branch", node } });
        }
      }
      if (node.kind === "branch") collect(node.children);
    }
  };
  collect(COMMAND_TREE);
  if (shortcuts.length > 0) {
    return shortcuts.sort((left, right) => left.order - right.order).map(({ match }) => match);
  }
  return searchCommands(normalized).map((entry) => ({ kind: "command", entry }));
}

type NodeHandlerId<Node> = Node extends { readonly handlerId: infer Handler extends string }
  ? Handler | (Node extends { readonly children: readonly (infer Child)[] } ? NodeHandlerId<Child> : never)
  : Node extends { readonly children: readonly (infer Child)[] }
    ? NodeHandlerId<Child>
    : never;

export type SlashCommandHandlerId = NodeHandlerId<(typeof COMMAND_TREE)[number]>;

export interface ResolvedCommandPath {
  readonly command: CommandLeafDefinition | CommandBranchDefinition;
  readonly handlerId: SlashCommandHandlerId;
  readonly matchedPath: readonly string[];
  readonly args: readonly string[];
}

export function resolveSlashCommand(input: string): ResolvedCommandPath | undefined {
  const withoutSlash = input.trimStart().replace(/^\//, "");
  const tokens = withoutSlash.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  for (const root of COMMAND_TREE) {
    const nodes = root.kind === "branch" && !("commandPrefix" in root && root.commandPrefix)
      ? root.children
      : [root];
    const resolved = resolveCommandNodes(nodes, tokens, []);
    if (resolved) return resolved;
  }
  const prefixAlias = findCommandBranch(COMMAND_TREE, tokens, []);
  return prefixAlias
    ? resolveCommandBranch(
        prefixAlias.branch,
        tokens.slice(prefixAlias.consumed),
        prefixAlias.path,
      )
    : undefined;
}

function aliasTokens(alias: string): readonly string[] {
  return alias.split(/\s+/).filter(Boolean);
}

function resolveCommandNodes(
  nodes: readonly CommandCatalogNode[],
  tokens: readonly string[],
  path: readonly string[],
): ResolvedCommandPath | undefined {
  const token = tokens[0]?.toLowerCase();
  if (!token) return undefined;
  for (const node of nodes) {
    if (node.kind === "branch" && !node.commandPrefix) {
      const nested = resolveCommandNodes(node.children, tokens, path);
      if (nested) return nested;
      continue;
    }
    const names = [node.name, ...(node.aliases ?? [])].map((name) => name.toLowerCase());
    if (!names.includes(token)) continue;
    if (node.kind === "command") {
      const args = tokens.slice(1);
      if (path.length > 0 && args.length > 0 && node.acceptsArguments !== true) {
        return undefined;
      }
      const command = COMMAND_CATALOG.find((entry) => entry.handlerId === node.handlerId)
        ?? flattenCommandTree([node], [path])[0]!;
      return {
        command,
        handlerId: node.handlerId as SlashCommandHandlerId,
        matchedPath: [...path, node.name],
        args,
      };
    }
    return resolveCommandBranch(node, tokens.slice(1), [...path, node.name]);
  }
  return undefined;
}

function resolveCommandBranch(
  branch: CommandBranchDefinition,
  tokens: readonly string[],
  path: readonly string[],
): ResolvedCommandPath | undefined {
  if (tokens.length === 0) {
    return branch.handlerId
      ? {
          command: branch,
          handlerId: branch.handlerId as SlashCommandHandlerId,
          matchedPath: path,
          args: [],
        }
      : undefined;
  }
  return resolveCommandNodes(branch.children, tokens, path);
}

/**
 * Finds the command branch whose compatibility alias opens `tokens`, and
 * reports how many tokens that alias consumed — an alias may be a whole
 * retired path (`collab cross`), not just one word. The returned `path` is
 * always the branch's CANONICAL prefix, so a match through an alias produces
 * exactly the same `matchedPath` the canonical spelling would.
 */
function findCommandBranch(
  nodes: readonly CommandCatalogNode[],
  tokens: readonly string[],
  path: readonly string[],
): { branch: CommandBranchDefinition; path: readonly string[]; consumed: number } | undefined {
  for (const node of nodes) {
    if (node.kind !== "branch") continue;
    const nextPath = node.commandPrefix ? [...path, node.name] : path;
    const matched = node.commandPrefix
      ? (node.aliases ?? [])
          .map((alias) => aliasTokens(alias.toLowerCase()))
          .find((candidate) =>
            candidate.every((token, index) => tokens[index]?.toLowerCase() === token))
      : undefined;
    if (matched) return { branch: node, path: nextPath, consumed: matched.length };
    const nested = findCommandBranch(node.children, tokens, nextPath);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Browse-only: the nodes at one path through the tree — branches and their
 * immediate commands — for when there is no query to search. This never
 * ranks or filters by text; that is `searchCommands`'s job over the
 * flattened leaf catalog, not this level-by-level walk. Empty `path`
 * returns the six root groups.
 *
 * A path may also start at a branch's compatibility alias (`["collab",
 * "cross"]`), which lands on the very same children the canonical path
 * (`["Models", "cross"]`) reaches — the palette itself only ever builds
 * canonical paths.
 */
export function commandTreeLevel(path: readonly string[]): readonly CommandCatalogNode[] {
  let nodes: readonly CommandCatalogNode[] = COMMAND_TREE;
  let remaining = path;
  if (remaining.length > 0) {
    const first = remaining[0]!.toLowerCase();
    const rootMatch = nodes.some((candidate) =>
      candidate.name.toLowerCase() === first
      || candidate.aliases?.some((alias) => alias.toLowerCase() === first));
    if (!rootMatch) {
      const branch = findCommandBranch(COMMAND_TREE, remaining, []);
      if (branch) {
        nodes = branch.branch.children;
        remaining = remaining.slice(branch.consumed);
      }
    }
  }
  for (const pathToken of remaining) {
    const normalized = pathToken.toLowerCase();
    const node = nodes.find((candidate) =>
      candidate.name.toLowerCase() === normalized
      || candidate.aliases?.some((alias) => alias.toLowerCase() === normalized),
    );
    if (!node || node.kind !== "branch") return [];
    nodes = node.children;
  }
  return nodes;
}

/**
 * The one global search: every executable leaf in the flattened catalog is
 * matched against its own full canonical path (e.g. "cross swap") and every
 * alias, never against a branch/group label — group nodes never
 * participate, so they can never surface as an "executable match". Ranking
 * is four ordered tiers, highest first:
 *
 *   3 — exact: the query equals a name or alias exactly, compatibility
 *       aliases included — typing a retired path in full is deliberate and
 *       unambiguous, and must land on the command it names.
 *   2 — prefix-of-name: a CANONICAL name or a same-command alias starts
 *       with the query (this alone covers most everyday typing, e.g. "set"
 *       -> "settings"). FIX-14 ticket 20: a compatibility-prefix alias
 *       cannot reach this tier. `/cross swap` carries the alias "collab
 *       cross swap" for the retired `collab` umbrella, and "collab cross
 *       swap".startsWith("co") is true — so typing "co" used to rank every
 *       Cross row at the SAME tier as `/cost`, `/compress` and `/context`,
 *       whose own names actually begin that way, and ahead of them on
 *       definition order. A retired spelling must keep working; it must not
 *       outrank a live name.
 *   1 — prefix-of-path-token: some token within a name or alias — a
 *       trailing token, or a token of a compatibility alias such as
 *       "collab cross swap" — starts with the query (e.g. "sw" reaching
 *       "cross swap" through its "swap" token). Compatibility-prefix
 *       aliases still match here, so nothing becomes unreachable.
 *   0 — substring: the query appears anywhere inside a name or alias
 *       (e.g. "pro" reaching "allow" through its "approval" alias).
 *
 * Ties within a tier keep the command tree's own definition order, so the
 * result is deterministic without an extra tie-break heuristic.
 */
export function searchCommands(
  query: string,
  catalog: readonly CommandCatalogEntry[] = COMMAND_CATALOG,
): readonly CommandCatalogEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return catalog
    .map((entry, index) => ({ entry, index, tier: commandMatchTier(entry, normalized) }))
    .filter((candidate) => candidate.tier >= 0)
    .sort((left, right) => right.tier - left.tier || left.index - right.index)
    .map((candidate) => candidate.entry);
}

function commandMatchTier(entry: CommandCatalogEntry, query: string): number {
  const aliases = "aliases" in entry ? entry.aliases : [];
  const identifiers = [entry.name, ...aliases].map((identifier) => identifier.toLowerCase());
  const canonical = identifiers.filter(
    (identifier) => identifier === entry.name.toLowerCase()
      || !isCompatibilityPrefixAlias(entry.name, identifier),
  );
  if (identifiers.includes(query)) return 3;
  if (canonical.some((identifier) => identifier.startsWith(query))) return 2;
  const tokens = identifiers.flatMap((identifier) => identifier.split(/\s+/));
  if (tokens.some((token) => token.startsWith(query))) return 1;
  if (identifiers.some((identifier) => identifier.includes(query))) return 0;
  return -1;
}

/**
 * FIX-14 ticket 20: is `alias` merely this command's canonical path wearing
 * a retired prefix?
 *
 * That is exactly what `flattenCommandTree`'s `inheritedAliases` produce: a
 * branch compatibility alias replaces the canonical prefix, so the result
 * ENDS with the canonical name and is strictly longer in tokens
 * (`cross swap` -> `collab cross swap`). Every other alias — a plain synonym
 * (`chat`/`chats`), a differently-named leaf under the same prefix — fails
 * both halves of that test and keeps its full ranking.
 */
function isCompatibilityPrefixAlias(name: string, alias: string): boolean {
  const nameTokens = name.toLowerCase().split(/\s+/).filter(Boolean);
  const aliasTokens = alias.toLowerCase().split(/\s+/).filter(Boolean);
  if (aliasTokens.length <= nameTokens.length) return false;
  const tail = aliasTokens.slice(aliasTokens.length - nameTokens.length);
  return tail.every((token, index) => token === nameTokens[index]);
}

export function commandTokenIsExact(
  input: string,
  command: SlashCommandDefinition,
): boolean {
  const inputTokens = input
    .slice(1)
    .trimStart()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return [command.name, ...(command.aliases ?? [])].some((name) =>
    name.toLowerCase().split(/\s+/).every(
      (token, index) => inputTokens[index] === token,
    ),
  );
}

/* -------------------------------------------------------------------------
 * What a Cross run leaves reachable, and the sentence that says so.
 * ---------------------------------------------------------------------- */

/**
 * The four handler ids a live Cross run does not block, as one list.
 *
 * It lives HERE rather than in `cli.ts` because `commands.ts` is a consumer
 * too and cannot import `cli.ts` (the dependency runs the other way). That
 * import direction is exactly why a fourth inline copy survived the G3 fix
 * round at `handleSlashCommand`'s own gate — the shared dispatcher every
 * surface calls was the one place that could not reach the shared list.
 *
 * Four surfaces read it now: the dashboard's loop, the plain loop, the GUI
 * sidecar, and the dispatcher itself. A command refused on one is refused on
 * every other, with the same words.
 */
export const CROSS_RUN_ACTIVE_COMMANDS: ReadonlySet<string> = new Set([
  "collab-cross-status",
  "collab-cross-stop",
  "collab-cross-off",
  "quit",
]);

export const CROSS_RUN_ACTIVE_COMMAND_NOTICE =
  "Cross is already running. Only /cross status, /cross stop, /cross off, and /quit are available while it runs.";

export function commandAllowedDuringCrossRun(completedCommand: string): boolean {
  return CROSS_RUN_ACTIVE_COMMANDS.has(completedCommand);
}

/**
 * What a plain MESSAGE gets while a Cross run is in flight.
 *
 * A different situation from the command gate above and therefore a different
 * sentence — but one sentence, not three: the dashboard loop, the plain loop
 * and the GUI's `submit` refusal all print this.
 */
export const CROSS_RUN_ACTIVE_MESSAGE_NOTICE =
  "Cross is already running. Use /cross status, /cross stop, /cross off, or /quit.";
