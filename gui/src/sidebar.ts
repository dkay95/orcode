/**
 * The sidebar — Desktop v2's replacement for the hub SCREEN.
 *
 * The hub did not disappear; it stopped being a place you have to leave. Every
 * affordance it carried is here and permanent: the recent chats (clickable,
 * `chat.open`), a new chat (`chat.new`), the folder (bare `/folder`, whose
 * "create it?" question is the core's own D4 confirm) and Settings.
 *
 * The copy this file writes itself is German, because the window's chrome is
 * (the owner-approved mockup). Everything that comes off the WIRE is rendered
 * as the wire sent it — a chat's message count, cost, model and age are
 * `formatChatRow`'s own parts (`hub-model.ts`), and the provider-setup row is
 * the terminal's own sentence, word for word.
 */

import { el } from "./dom.js";
import { routeCoreBrand } from "./brand.js";
import type { HubRow } from "./hub-model.js";

export interface SidebarHandlers {
  openChat(id: string): void;
  newChat(): void;
  /** Dispatches a slash command through the engine, exactly as typing it would. */
  run(command: string): void;
  connect(): void;
  openSettings(): void;
}

export interface SidebarOptions {
  /** The chat the window is showing, so the list can mark it. */
  readonly activeChatId: string | null;
  /**
   * How many chats the engine actually returned. V4 rule 5, on this surface:
   * a list that shows fewer rows than it has says so, or it is silently
   * deciding for the owner which chats exist.
   */
  readonly total: number;
  /** The workspace, abbreviated — the same string the status bar shows. */
  readonly folder: string;
  /** The engine's full workspace path; `folder` remains the legacy fallback. */
  readonly workspace?: string;
  /** The canonical compact-brand appearance preference, never a local override. */
  readonly showBrand?: boolean;
  /**
   * FIX-17's ruling, carried onto this surface: while no route resolves,
   * provider setup is a calm, permanent affordance — never an unsolicited
   * launch modal. It is computed from `status.routeConnected` per render, so
   * it retires by itself the moment a route resolves.
   */
  readonly setupNeeded: boolean;
  /** True while the engine's Settings session owns the window. */
  readonly settingsOpen: boolean;
  /**
   * False until the engine answers `status.get`. Every row here reaches the
   * wire, and before readiness there is nothing on the other end — so the
   * rows are disabled rather than clickable-and-silently-refused (review i3).
   */
  readonly ready: boolean;
}

export function sidebar(
  rows: readonly HubRow[],
  handlers: SidebarHandlers,
  options: SidebarOptions,
): HTMLElement {
  const side = el("aside", { class: "side", "aria-label": "Projekt und Chats" });

  if (options.showBrand) {
    const brand = routeCoreBrand("chat-header");
    brand.className = "route-core-brand route-core-brand--sidebar";
    side.append(el("div", { class: "sidebar-brand" }, [
      brand,
      el("span", { class: "sidebar-brand-caption", text: "Route Core" }),
    ]));
  }

  const workspace = options.workspace || options.folder;
  const projectName = workspace.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || workspace || "Kein Projektordner";
  const projectChange = footRow("▦", "Ordner", { ready: options.ready }, () =>
    handlers.run("/folder"),
  );
  projectChange.classList.add("project-change");
  side.append(el("section", { class: "project-context", title: workspace, "aria-label": "Aktuelles Projekt" }, [
    el("span", { class: "project-label", text: "Projekt" }),
    el("strong", { class: "project-name", text: projectName }),
    workspace ? el("span", { class: "project-path mono", text: workspace }) : null,
    projectChange,
  ]));

  const newChat = el("button", {
    class: "newchat",
    type: "button",
    disabled: !options.ready,
  }, [
    el("span", { class: "plus", text: "+", "aria-hidden": "true" }),
    el("span", { text: "Neuer Chat" }),
  ]);
  newChat.addEventListener("click", () => handlers.newChat());
  side.append(newChat);

  side.append(el("h2", { class: "sec", text: "Letzte Chats" }));

  const list = el("div", { class: "chatlist" });
  if (rows.length === 0) {
    list.append(el("div", { class: "empty", text: "Noch keine Chats." }));
  }
  for (const row of rows) {
    list.append(
      chatItem(row, row.id === options.activeChatId, options.ready, () =>
        handlers.openChat(row.id),
      ),
    );
  }
  if (options.total > rows.length) {
    list.append(
      el("div", { class: "counter", text: `${rows.length} von ${options.total} · ▾` }),
    );
  }
  side.append(list);

  const foot = el("div", { class: "foot" });
  if (options.setupNeeded) {
    foot.append(
      footRow("◈", "Verbinden", { ready: options.ready }, handlers.connect),
    );
  }
  foot.append(
    // Marked while Settings holds the session: the row is where you already
    // are, and clicking it deliberately does nothing.
    footRow("⚙", "Einstellungen", { ready: options.ready, current: options.settingsOpen }, () =>
      handlers.openSettings(),
    ),
  );
  side.append(foot);
  return side;
}

function chatItem(row: HubRow, active: boolean, ready: boolean, open: () => void): HTMLElement {
  const facts: (Node | null)[] = [];
  const push = (node: HTMLElement): void => {
    if (facts.length > 0) facts.push(el("span", { text: "·" }));
    facts.push(node);
  };
  if (row.cost) push(el("span", { class: "cost mono", text: row.cost }));
  if (row.model) push(el("span", { text: row.model }));
  // A chat in ANOTHER folder: opening it re-roots the whole runtime, so the
  // row says which folder before it is clicked rather than after.
  if (row.folder) push(el("span", { class: "folder mono", text: row.folder }));

  const node = el(
    "button",
    {
      class: "chatitem",
      type: "button",
      disabled: !ready,
      // Stamped only when true: `aria-current="false"` on every other row is
      // valid but noisy for a screen reader (review i4).
      ...(active ? { "aria-current": "true" } : {}),
      // The terminal's own composed sentence for this row, kept whole and
      // reachable — the two-line layout above is an arrangement of its parts,
      // never a re-wording of them.
      title: `${row.title}\n${row.detail}`,
    },
    [
      el("div", { class: "t" }, [
        el("span", { class: "title", text: row.title }),
        el("small", { class: "age", text: row.age }),
      ]),
      el("div", { class: "m" }, facts),
    ],
  );
  node.addEventListener("click", open);
  return node;
}

function footRow(
  icon: string,
  name: string,
  extra: { value?: string; detail?: string; ready: boolean; current?: boolean },
  activate: () => void,
): HTMLElement {
  const node = el("button", {
    class: extra.value ? "footrow footrow--with-value" : "footrow",
    type: "button",
    title: extra.value ?? "",
    disabled: !extra.ready,
    ...(extra.current ? { "aria-current": "true" } : {}),
  }, [
    el("span", { class: "ic", text: icon, "aria-hidden": "true" }),
    el("span", { class: "l" }, [
      el("span", { class: "n", text: name }),
      extra.detail ? el("span", { class: "d", text: extra.detail }) : null,
    ]),
    extra.value ? el("span", { class: "value", text: extra.value }) : null,
  ]);
  node.addEventListener("click", activate);
  return node;
}
