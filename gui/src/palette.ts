/**
 * The command palette — catalog-fed, and nothing else.
 *
 * Desktop v2 gives it the shape people already know from a launcher: a
 * floating card near the top of the window, a big field, rows underneath. What
 * did NOT change is where its content comes from. Every row, every
 * description, every location and every Enter VERB arrives from
 * `catalog.level` / `catalog.search`, which the engine serves from
 * `resolveCommandMenuRows` — the same one data path Ctrl+P and inline `/`
 * completion use in the terminal. This file holds a cursor and draws; it never
 * decides what a command is, where it lives, or what pressing Return will do
 * to it.
 *
 * The verb matters more than it looks. FIX-11's finding was a footer that said
 * `Enter run` on rows Enter did not run. The rule the engine applies: an
 * argument-less leaf RUNS, a leaf that takes arguments only INSERTS (running
 * it would discard the argument the palette was opened to type), and a browse
 * branch OPENS one level. This window renders that word and then does exactly
 * it.
 */

import { listWindow } from "@core/utils";

import { el, replace } from "./dom.js";
import { normalizeCatalogQuery } from "./slash-complete.js";
import type { GuiPaletteRow } from "./protocol.js";

export type PaletteRow = GuiPaletteRow;

export interface PaletteLevel {
  readonly crumb: readonly string[];
  readonly rows: readonly PaletteRow[];
  readonly total: number;
}

/** How many rows the card puts on screen at once. */
export const PALETTE_VISIBLE_ROWS = 12;

export interface PaletteState {
  path: string[];
  query: string;
  selected: number;
  crumb: readonly string[];
  rows: readonly PaletteRow[];
  total: number;
}

export function emptyPalette(): PaletteState {
  return { path: [], query: "", selected: 0, crumb: ["Commands"], rows: [], total: 0 };
}

/** Wrapping cursor movement over the rows the wire handed over. */
export function movePalette(state: PaletteState, delta: number): void {
  if (state.rows.length === 0) {
    state.selected = 0;
    return;
  }
  state.selected = (state.selected + delta + state.rows.length) % state.rows.length;
}

export function selectedRow(state: PaletteState): PaletteRow | null {
  return state.rows[state.selected] ?? null;
}

/**
 * The rows actually on screen, and where they start.
 *
 * The window FOLLOWS the selection (`listWindow`, shared with the terminal's
 * own pickers). Rendering a fixed first twelve while ↓ walked past them put
 * the cursor off screen: no marker anywhere, and Return acting on a command
 * nobody could see.
 */
export function visibleRows(state: PaletteState): {
  readonly start: number;
  readonly rows: readonly PaletteRow[];
} {
  const { start, rows } = listWindow(state.rows.length, state.selected, PALETTE_VISIBLE_ROWS);
  return { start, rows: state.rows.slice(start, start + rows) };
}

/**
 * The rank counter (V4 rule 5): a list that shows fewer rows than it has says
 * so, and which side is hidden. Without it the palette silently decides which
 * commands exist.
 */
export function rankCounter(state: PaletteState): string | null {
  const { start, rows } = visibleRows(state);
  if (rows.length >= state.total) return null;
  const above = start > 0 ? "▴" : "";
  const below = start + rows.length < state.rows.length ? "▾" : "";
  return `${rows.length} von ${state.total} · ${above}${below}`;
}

export interface PaletteHandlers {
  activate(row: PaletteRow): void;
  filter(query: string): void;
  move(delta: number): void;
  /** One level back up the browsed tree. */
  up(): void;
}

export interface PalettePanel {
  /** Dialog content for OverlayManager to mount. */
  readonly node: HTMLElement;
  /** Redraws the rows in place — the field the owner is typing into stays. */
  update(): void;
}

/**
 * Mounted ONCE, redrawn in place.
 *
 * Rebuilding this card per keystroke would clear the filter field and move the
 * caret — the same defect G2 fixed for the ask panels, for the same reason: a
 * palette you cannot type into is not keyboard-first.
 */
export function palettePanel(state: PaletteState, handlers: PaletteHandlers): PalettePanel {
  const card = el("div", { class: "modal palette" });

  const crumbBar = el("h2", { class: "crumb", "data-overlay-heading": "" });
  card.append(crumbBar);

  const input = el("input", {
    type: "text",
    class: "filter",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "Befehl suchen …",
    "data-overlay-safe-action": "",
  }) as HTMLInputElement;
  input.value = state.query;
  input.addEventListener("input", () => handlers.filter(normalizeCatalogQuery(input.value)));
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      handlers.move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = selectedRow(state);
      if (row && !row.presentation.disabled) handlers.activate(row);
      return;
    }
    if (event.key === "Backspace" && input.value === "" && state.path.length > 0) {
      // Only with an empty field: Backspace in text is text editing, and a key
      // that means two things depending on invisible state is the kind of
      // surprise a footer cannot honestly describe.
      event.preventDefault();
      handlers.up();
      return;
    }
  });
  card.append(
    el("label", { class: "palette-filter-label" }, [
      el("span", { text: "Befehl suchen" }),
      input,
    ]),
  );

  const list = el("div", { class: "list" });
  card.append(list);
  const counterSlot = el("div");
  card.append(counterSlot);
  const foot = el("div", { class: "foot" });
  card.append(foot);

  const update = (): void => {
    // The crumb, composed by the engine (`commandMenuCrumbParts`), so it can
    // never disagree with the terminal about where the palette is.
    const crumb: Node[] = [];
    state.crumb.forEach((part, index) => {
      if (index > 0) crumb.push(el("span", { class: "crumb-sep", text: "›" }));
      const labels: Record<string, string> = { Commands: "Befehle", Models: "Modelle", Chat: "Chat", Workspace: "Arbeitsbereich", Accounts: "Konten", "Approvals & Costs": "Freigaben & Kosten", System: "System" };
      crumb.push(el("span", { text: labels[part] ?? part }));
    });
    replace(crumbBar, crumb);

    const rows: HTMLElement[] = [];
    if (state.rows.length === 0) {
      rows.push(el("div", { class: "empty", text: "Hier gibt es keine Befehle." }));
    }
    const window_ = visibleRows(state);
    window_.rows.forEach((row, offset) => {
      const index = window_.start + offset;
      const disabled = row.presentation.disabled !== undefined;
      const node = el(
        "button",
        {
          class: "prow",
          type: "button",
          "aria-selected": index === state.selected ? "true" : "false",
          disabled,
          "aria-disabled": disabled ? "true" : undefined,
        },
        [
          el("span", { class: "n", text: desktopCatalogLabel(row.name) }),
          el("span", { class: "d", text: row.presentation.description }),
          el("span", { class: "verb", text: row.presentation.disabled?.label ?? row.presentation.actionLabel }),
          ...(row.presentation.currentLabel ? [el("span", { class: "current", text: row.presentation.currentLabel })] : []),
        ],
      );
      node.addEventListener("click", () => {
        if (!disabled) handlers.activate(row);
      });
      rows.push(node);
    });
    replace(list, rows);

    const counter = rankCounter(state);
    replace(counterSlot, counter ? [el("div", { class: "counter", text: counter })] : []);

    // Every key named here is a key the palette binds, and the Enter hint says
    // the ENGINE's verb rather than a hopeful "run".
    const current = selectedRow(state);
    const hints: HTMLElement[] = [
      hint("Enter", current ? current.presentation.disabled?.label ?? current.presentation.actionLabel : "—"),
      hint("↑↓", "bewegen"),
    ];
    if (state.path.length > 0 && !state.query) hints.push(hint("Backspace", "eine Ebene zurück"));
    hints.push(hint("Esc", "schließen"));
    replace(foot, hints);
  };

  update();
  return { node: card, update };
}

function hint(key: string, effect: string): HTMLElement {
  return el("span", {}, [el("span", { class: "k", text: key }), el("span", { text: effect })]);
}

function desktopCatalogLabel(value: string): string {
  return ({ Models: "Modelle", Workspace: "Arbeitsbereich", Accounts: "Konten", "Approvals & Costs": "Freigaben & Kosten" } as Record<string, string>)[value] ?? value;
}
