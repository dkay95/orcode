/**
 * Progressive Desktop Settings, rendered only from the canonical projection.
 * Foundation owns labels, values, disabled explanations and notices; this
 * module owns only layout and German control chrome.
 */

import { el } from "./dom.js";
import type {
  DesktopSettingsIntent,
  DesktopSettingsRow,
  DesktopSettingsView,
} from "./protocol.js";

export interface SettingsHandlers {
  dispatch(intent: DesktopSettingsIntent): void;
  close(): void;
}

export interface SettingsLocalPresentation {
  readonly searchDraft?: string;
  readonly requestError?: string;
}

export function settingsHeader(
  _view: DesktopSettingsView,
  handlers: SettingsHandlers,
): HTMLElement {
  const head = el("header", { class: "chathead sethead-row" }, [
    el("span", { class: "title", text: "Einstellungen" }),
    el("span", { class: "spacer" }),
  ]);
  const done = el("button", { class: "iconbtn", type: "button", text: "Fertig" });
  done.addEventListener("click", () => handlers.close());
  head.append(done);
  return head;
}

export function settingsContent(
  view: DesktopSettingsView,
  handlers: SettingsHandlers,
  local: SettingsLocalPresentation = {},
): HTMLElement {
  const content = el("div", { class: "settings" });
  const nav = el("div", { class: "setnav", role: "tablist", "aria-label": "Einstellungsbereiche" });
  for (const category of view.categories) {
    const active = !view.search.active && category.id === view.selectedCategoryId;
    const tab = el("button", {
      class: "tab",
      type: "button",
      role: "tab",
      "aria-selected": active ? "true" : "false",
      title: category.description,
      text: category.label,
      "data-settings-category": category.id,
    });
    tab.addEventListener("click", () => handlers.dispatch({
      kind: "select-category",
      categoryId: category.id,
      revision: view.revision,
    }));
    nav.append(tab);
  }
  content.append(nav);

  const body = el("div", { class: "setbody" });
  const search = el("input", {
    type: "search",
    class: "setsearch settings-search",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "Alle Einstellungen durchsuchen",
    "aria-label": "Einstellungen durchsuchen",
  }) as HTMLInputElement;
  search.value = local.searchDraft ?? view.search.query;
  search.addEventListener("input", () => handlers.dispatch({
    kind: "search-change",
    query: search.value,
    revision: view.revision,
  }));
  body.append(search);

  const card = el("div", { class: "setcard" });
  if (view.search.active) {
    appendRows(card, view.search.results, view, handlers, false);
  } else {
    const selected = view.categories.find(({ id }) => id === view.selectedCategoryId);
    if (selected) {
      appendRows(card, selected.commonItems, view, handlers, false);
      if (selected.advancedItems.length > 0) {
        const more = el("button", {
          class: "settings-more",
          type: "button",
          "aria-expanded": selected.expanded ? "true" : "false",
          text: selected.expanded ? "Weitere Einstellungen ausblenden" : "Weitere Einstellungen",
          "data-settings-more": selected.id,
        });
        more.addEventListener("click", () => handlers.dispatch({
          kind: "toggle-advanced",
          categoryId: selected.id,
          revision: view.revision,
        }));
        card.append(more);
        if (selected.expanded) appendRows(card, selected.advancedItems, view, handlers, true);
      }
    }
  }
  if (!card.querySelector(".settings-row")) {
    card.append(el("div", {
      class: "setempty",
      text: view.search.active && view.search.query
        ? `Keine Treffer für ${view.search.query}`
        : "Keine Einstellungen in diesem Bereich",
    }));
  }
  body.append(card);

  if (view.notice) {
    body.append(el("div", {
      class: "setnotice",
      "data-level": view.notice.level,
      text: view.notice.label,
    }));
  }
  if (local.requestError) {
    body.append(el("div", {
      class: "setnotice settings-request-error",
      "data-level": "error",
      text: local.requestError,
    }));
  }
  body.append(el("div", {
    class: "counter",
    text: "←→ / 1-4 Bereich · / suchen · Enter ändern · Esc zurück",
  }));
  content.append(body);
  return content;
}

function appendRows(
  parent: HTMLElement,
  rows: readonly DesktopSettingsRow[],
  view: DesktopSettingsView,
  handlers: SettingsHandlers,
  advanced: boolean,
): void {
  for (const row of rows) parent.append(settingsRow(row, view, handlers, advanced));
}

function settingsRow(
  row: DesktopSettingsRow,
  view: DesktopSettingsView,
  handlers: SettingsHandlers,
  advanced: boolean,
): HTMLElement {
  if (row.control === "readonly") {
    return el("div", {
      class: "setrow settings-row settings-readonly",
      ...(row.focusKey ? { "data-settings-focus-key": row.focusKey } : {}),
    }, [
      el("span", { class: "l" }, [
        el("span", { class: `n name${advanced ? " settings-advanced" : ""}`, text: row.label }),
        el("span", { class: "d detail", text: row.description }),
      ]),
      el("span", { class: "v value", text: row.displayValue }),
    ]);
  }
  const unavailable = row.control === "locked" || row.disabled !== undefined;
  const isBoolean = row.control === "boolean";
  const disabled = unavailable || (isBoolean && row.booleanValue === undefined);
  const value = isBoolean
    ? el("span", { class: "toggle value", "data-on": row.booleanValue === true ? "true" : "false" })
    : el("span", { class: "v value" }, [
        el("span", { text: row.actionLabel ?? row.displayValue }),
        ...(row.control === "choice" ? [el("span", { text: "▾" })] : []),
      ]);
  const node = el("button", {
    class: "setrow settings-row",
    type: "button",
    ...(isBoolean ? { role: "switch", "aria-checked": row.booleanValue === true ? "true" : "false" } : {}),
    "aria-disabled": disabled ? "true" : undefined,
    disabled,
    ...(row.focusKey ? { "data-settings-focus-key": row.focusKey } : {}),
  }, [
    el("span", { class: "l" }, [
      el("span", { class: `n name${advanced ? " settings-advanced" : ""}`, text: row.label }),
      el("span", { class: "d detail", text: row.description }),
      ...(row.disabled
        ? [
            el("span", { class: "d detail warn settings-disabled", text: row.disabled.label }),
            ...(row.disabled.recoveryLabel
              ? [el("span", { class: "d detail settings-recovery", text: row.disabled.recoveryLabel })]
              : []),
          ]
        : []),
    ]),
    value,
  ]) as HTMLButtonElement;
  if (!disabled) {
    node.addEventListener("click", () => {
      if (isBoolean) {
        handlers.dispatch({
          kind: "set-boolean",
          handle: row.handle,
          value: !row.booleanValue,
          revision: view.revision,
        });
      } else {
        handlers.dispatch({ kind: "activate-row", handle: row.handle, revision: view.revision });
      }
    });
  }
  return node;
}
