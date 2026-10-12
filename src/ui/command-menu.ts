import {
  commandTreeLevel,
  searchCommandMenuCatalog,
  type CommandMenuCatalogEntry,
  type CommandCatalogNode,
  type SlashCommandHandlerId,
} from "../command-catalog.js";
import type { ListEntry } from "./dashboard-frame.js";
import type { DesktopCommandDisabledPresentation } from "../desktop-contracts.js";
import { createTheme, type Theme } from "./theme.js";

export interface CommandMenuState {
  readonly path: readonly string[];
  readonly query: string;
  readonly selectedIndex: number;
}

export type CommandMenuRuntime = ReadonlyMap<SlashCommandHandlerId, {
  readonly current?: string;
  readonly disabledReason?: string;
  readonly currentLabel?: string;
  readonly disabled?: DesktopCommandDisabledPresentation;
}>;

/**
 * One row the shared menu can show: a browse-mode tree node (branch or
 * command, at whatever path is being browsed), a global search match
 * (always an executable leaf), or the no-match recovery action.
 */
export type CommandMenuRow =
  | { readonly kind: "node"; readonly node: CommandCatalogNode }
  | { readonly kind: "match"; readonly entry: CommandMenuCatalogEntry }
  | { readonly kind: "recovery"; readonly query: string };

/**
 * The one data path Ctrl+P and inline `/` completion both call. An empty
 * query browses the tree at `path` — the unchanged hierarchical navigation
 * groups stay browse-only under. Any other query searches every executable
 * leaf globally, ignoring `path`: the whole point of a global finder is
 * that wherever you were browsing never narrows what you can reach next.
 * A query with zero matches never renders a dead end — it falls back to
 * one recovery row that clears the search and opens the root tree.
 */
export function resolveCommandMenuRows(state: CommandMenuState): readonly CommandMenuRow[] {
  const query = state.query.trim();
  if (!query) {
    return commandTreeLevel(state.path).map((node) => ({ kind: "node", node }) as const);
  }
  const matches = searchCommandMenuCatalog(query);
  if (matches.length === 0) return [{ kind: "recovery", query } as const];
  return matches.map((match) => match.kind === "branch"
    ? ({ kind: "node", node: match.node }) as const
    : ({ kind: "match", entry: match.entry }) as const);
}

/**
 * FIX-11 (rendered truth): what Enter actually does to the selected row, in
 * the palette footer's own vocabulary. The controller ruling behind it: an
 * argument-less leaf RUNS on Enter (there is nothing left to type, so the
 * second Return the old flow demanded was pure ceremony), while a leaf that
 * takes arguments only fills the composer — running it would silently
 * discard the argument the user opened the palette to type. Reads the exact
 * same catalog flag Tab's trailing space already reads, so the footer can
 * never drift from `tui.ts`'s `#activateCommandLeaf`.
 *
 * Addendum, controller ruling B: the non-leaf rows are covered too, because
 * `Enter run` on a row that opens a sublevel was the same class of footer
 * lie. Every row now names its own behavior:
 *
 *   run    — an argument-less leaf; Enter executes it outright.
 *   insert — a leaf that takes arguments, and the one actionable branch
 *            (`cross`), whose Enter likewise only fills the composer
 *            (with `/cross`) rather than opening its children.
 *   open   — a browse branch, whose Enter descends one level, and the
 *            no-match recovery row, whose Enter clears the failed query and
 *            opens the root tree.
 */
export function commandMenuEnterVerb(row: CommandMenuRow | undefined): "run" | "insert" | "open" {
  // The literal catalog's union types the flag away on the leaves that omit
  // it, so it is read exactly the way `tui.ts`'s own activation path reads
  // it — presence-checked first, never assumed.
  if (row?.kind === "match") {
    return "acceptsArguments" in row.entry && row.entry.acceptsArguments === true ? "insert" : "run";
  }
  if (row?.kind === "node") {
    if (row.node.kind === "command") {
      return "acceptsArguments" in row.node && row.node.acceptsArguments === true ? "insert" : "run";
    }
    // A branch carrying a `handlerId` is actionable: `#handleCommandMenuKey`
    // replaces the composer with its command instead of descending, so it
    // belongs with the leaves that insert, not with the branches that open.
    return row.node.handlerId ? "insert" : "open";
  }
  return "open";
}

export interface CommandMenuProjection {
  readonly breadcrumb: string;
  readonly entries: readonly ListEntry[];
}

/**
 * `theme` defaults to the plain non-ASCII theme so every existing caller
 * that only cares about the data (path/query projection, not the rendered
 * glyph) keeps working unchanged; real rendering call sites (`tui.ts`) pass
 * their own live theme so the crumb's `›` honors NO_COLOR/ASCII parity like
 * every other glyph in the project (F2 ruling 2 — no raw non-ASCII literals
 * outside the theme).
 */
/**
 * The palette's location, as PARTS.
 *
 * A search has no "current location" — it already reaches every leaf — so
 * the crumb drops the browsed path while a query is active. Kept as parts
 * because the two surfaces join them differently: the terminal with the
 * theme's `chevron` glyph (below), the window with its own crumb bar. One
 * composition, two renderings — never two compositions.
 */
export function commandMenuCrumbParts(
  state: Pick<CommandMenuState, "path" | "query">,
): readonly string[] {
  return state.query.trim() ? ["Commands"] : ["Commands", ...state.path];
}

export function projectCommandMenu(
  state: CommandMenuState,
  runtime: CommandMenuRuntime,
  theme: Theme = createTheme(),
): CommandMenuProjection {
  return {
    breadcrumb: commandMenuCrumbParts(state).join(theme.glyph("chevron")),
    entries: resolveCommandMenuRows(state).map((row) => projectRow(row, runtime, theme)),
  };
}

function projectRow(row: CommandMenuRow, runtime: CommandMenuRuntime, theme: Theme): ListEntry {
  if (row.kind === "recovery") {
    return {
      name: "Show all commands",
      description: `No matches for "${row.query}"${theme.glyph("separator")}input will be cleared`,
    };
  }
  if (row.kind === "node") {
    const { node } = row;
    const status = node.kind === "command" ? runtime.get(node.handlerId as SlashCommandHandlerId) : undefined;
    return {
      name: node.kind === "command" || node.handlerId ? `/${node.name}` : node.name,
      description: node.description,
      current: status?.current,
      disabledReason: status?.disabledReason,
    };
  }
  const status = runtime.get(row.entry.handlerId as SlashCommandHandlerId);
  return {
    name: `/${row.entry.name}`,
    description: row.entry.description,
    current: status?.current,
    disabledReason: status?.disabledReason,
  };
}
