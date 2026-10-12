import { el } from "./dom.js";
import type { GuiPaletteRow } from "./protocol.js";

export interface SlashCompletionState {
  readonly raw: string;
  readonly rows: readonly GuiPaletteRow[];
  readonly selected: number;
}

export interface SlashCompletionHandlers { choose(row: GuiPaletteRow): void; }

export function normalizeCatalogQuery(raw: string): string {
  return (raw.startsWith("/") ? raw.slice(1) : raw).trim();
}

export function slashCompletionPanel(state: SlashCompletionState, handlers: SlashCompletionHandlers): HTMLElement {
  return el("div", { class: "slash-complete", role: "listbox", "aria-label": "Befehlsvorschläge" },
    state.rows.map((row, index) => {
      const disabled = row.presentation.disabled !== undefined;
      const button = el("button", {
        type: "button", role: "option", class: "slash-option",
        "aria-selected": index === state.selected ? "true" : "false",
        disabled,
        "aria-disabled": disabled ? "true" : undefined,
      }, [
        el("span", { class: "usage", text: row.command ?? row.usage ?? row.name }),
        el("span", { class: "description", text: row.presentation.description }),
        el("span", { class: "action", text: row.presentation.disabled?.label ?? row.presentation.actionLabel }),
      ]);
      button.addEventListener("click", () => {
        if (!disabled) handlers.choose(row);
      });
      return button;
    }));
}
