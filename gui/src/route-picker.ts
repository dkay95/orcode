/**
 * The one route picker used by onboarding and, later, settings/Cross.
 *
 * Provider and account names stay canonical: provider labels come from the
 * provider that owns each route, while every route fact is rendered directly
 * from the Foundation candidate. This module owns only German UI chrome and
 * enum presentation. It never infers availability, price, policy, or a label
 * from a provider id.
 */

import { el } from "./dom.js";
import type {
  DesktopModelCapability,
  DesktopProviderCapability,
  DesktopRouteCandidate,
} from "./protocol.js";

export type RoutePickerPurpose = "main" | "lead" | "challenger";

export interface RoutePickerOptions {
  readonly purpose: RoutePickerPurpose;
  readonly providers: readonly DesktopProviderCapability[];
  readonly routes: readonly DesktopRouteCandidate[];
  readonly canGoBack: boolean;
}

export interface RoutePickerHandlers {
  choose(routeHandle: string): void;
  back?(): void;
  cancel(): void;
}

const CAPABILITY_LABELS: Readonly<Record<DesktopModelCapability, string>> = {
  text: "Text",
  "image-input": "Bildeingabe",
  tools: "Werkzeuge",
  reasoning: "Denkmodus",
  patch: "Dateiänderungen",
};

const REASONING_LABELS: Readonly<Record<DesktopRouteCandidate["reasoning"], string>> = {
  supported: "Denkmodus unterstützt",
  unsupported: "Denkmodus nicht unterstützt",
  unknown: "Denkmodus unbekannt",
};

function routeOwner(
  providers: readonly DesktopProviderCapability[],
  candidate: DesktopRouteCandidate,
): DesktopProviderCapability {
  const owner = providers.find((provider) =>
    provider.routes.some((route) => route.handle === candidate.handle),
  );
  if (!owner) {
    throw new Error("Route candidate has no canonical provider presentation");
  }
  return owner;
}

function purposeHeading(purpose: RoutePickerPurpose): string {
  if (purpose === "lead") return "Coding-Modell wählen";
  if (purpose === "challenger") return "Prüfmodell wählen";
  return "Modell und Konto wählen";
}

/** Render a fresh picker. No route is selected until the owner acts. */
export function routePicker(
  options: RoutePickerOptions,
  handlers: RoutePickerHandlers,
): HTMLElement {
  const card = el("section", { class: "modal route-picker" });
  card.append(el("h2", {
    text: purposeHeading(options.purpose),
    "data-overlay-heading": "",
  }));
  card.append(el("p", {
    class: "route-picker-intro",
    text: "Provider, Konto und Modell bewusst auswählen.",
  }));

  const search = el("input", {
    class: "route-picker-search-input",
    type: "search",
    placeholder: "Modell, Provider oder Konto",
    "aria-label": "Modelle, Provider oder Konten suchen",
    autocomplete: "off",
  });
  card.append(el("label", { class: "route-picker-search" }, [
    el("span", { text: "Modell suchen" }),
    search,
  ]));

  const list = el("div", {
    class: "route-picker-list",
    role: "group",
    "aria-label": "Verfügbare Modelle und Konten",
  });
  const optionNodes: HTMLButtonElement[] = [];
  const rows: { node: HTMLElement; searchText: string }[] = [];
  let selected: DesktopRouteCandidate | null = null;

  const confirm = el("button", {
    class: "btn primary",
    type: "button",
    disabled: true,
    text: "Auswählen",
  }) as HTMLButtonElement;

  const select = (candidate: DesktopRouteCandidate, node: HTMLButtonElement): void => {
    if (!candidate.runnable || candidate.disabled || node.closest("[hidden]")) return;
    selected = candidate;
    for (const option of optionNodes) option.setAttribute("aria-pressed", option === node ? "true" : "false");
    confirm.disabled = false;
  };

  const move = (from: number, delta: number): void => {
    if (optionNodes.length === 0) return;
    for (let offset = 1; offset <= optionNodes.length; offset += 1) {
      const index = (from + delta * offset + optionNodes.length) % optionNodes.length;
      const candidate = options.routes[index];
      const node = optionNodes[index];
      if (candidate?.runnable && !candidate.disabled && node && !rows[index]?.node.hidden) {
        node.focus();
        select(candidate, node);
        return;
      }
    }
  };

  options.routes.forEach((candidate, index) => {
    const owner = routeOwner(options.providers, candidate);
    const disabled = !candidate.runnable || candidate.disabled !== undefined;
    const facts: HTMLElement[] = [
      el("span", { class: "route-picker-primary" }, [
        el("strong", { class: "route-name", text: candidate.displayName }),
        el("span", { class: "route-picker-meta" }, [
          el("span", { class: "route-provider", text: owner.providerLabel }),
          " · ",
          el("span", { class: "route-account", text: candidate.accountLabel }),
        ]),
      ]),
      el("span", { class: "route-picker-facts" }, [
        el("span", { class: "route-cost", text: candidate.cost.label }),
        el("span", { class: "route-policy", text: candidate.dataPolicy.label }),
      ]),
    ];
    if (candidate.disabled) {
      facts.push(el("span", { class: "route-disabled-label", text: candidate.disabled.label }));
      if (candidate.disabled.recoveryLabel) {
        facts.push(el("span", { class: "route-recovery-label", text: candidate.disabled.recoveryLabel }));
      }
    } else if (!candidate.runnable) {
      facts.push(el("span", { class: "route-disabled-label", text: "Nicht verfügbar" }));
    }

    const option = el("button", {
      class: `route-option${disabled ? " is-disabled" : ""}`,
      type: "button",
      "aria-pressed": "false",
      "aria-disabled": disabled ? "true" : undefined,
      disabled,
    }, facts) as HTMLButtonElement;
    optionNodes.push(option);
    if (!disabled) {
      option.addEventListener("click", () => select(candidate, option));
      option.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          move(index, event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select(candidate, option);
        }
      });
    }
    const details = el("details", { class: "route-picker-details" }, [
      el("summary", {
        text: "Technische Details",
        "aria-label": `Technische Details zu ${candidate.displayName}`,
      }),
      el("div", { class: "route-picker-technical" }, [
        el("code", { class: "route-model-id", text: candidate.canonicalModelId }),
        el("span", { class: "route-reasoning", text: REASONING_LABELS[candidate.reasoning] }),
        el("span", {
          class: "route-capabilities",
          text: candidate.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(" · "),
        }),
      ]),
    ]);
    const row = el("div", { class: `route-picker-row${disabled ? " is-disabled" : ""}` }, [option, details]);
    rows.push({
      node: row,
      searchText: `${candidate.displayName} ${owner.providerLabel} ${candidate.accountLabel}`.toLocaleLowerCase("de"),
    });
    list.append(row);
  });

  const empty = el("p", {
    class: "empty route-picker-empty",
    role: "status",
    text: "Keine Modelle verfügbar.",
  });
  empty.hidden = options.routes.length !== 0;
  search.addEventListener("input", () => {
    const term = search.value.trim().toLocaleLowerCase("de");
    let visibleCount = 0;
    rows.forEach((row, index) => {
      row.node.hidden = !row.searchText.includes(term);
      if (!row.node.hidden) visibleCount += 1;
      if (row.node.hidden && options.routes[index]?.handle === selected?.handle) {
        selected = null;
        confirm.disabled = true;
        for (const option of optionNodes) option.setAttribute("aria-pressed", "false");
      }
    });
    empty.hidden = visibleCount !== 0;
    empty.textContent = options.routes.length === 0
      ? "Keine Modelle verfügbar."
      : "Keine Modelle passen zur Suche.";
  });
  card.append(list, empty);

  const actions = el("div", { class: "actions route-picker-actions" });
  const cancel = el("button", {
    class: "btn ghost",
    type: "button",
    text: "Abbrechen",
    "data-overlay-safe-action": "",
  });
  cancel.addEventListener("click", () => handlers.cancel());
  actions.append(cancel);
  if (options.canGoBack && handlers.back) {
    const back = el("button", { class: "btn ghost", type: "button", text: "Zurück" });
    back.addEventListener("click", () => handlers.back?.());
    actions.append(back);
  }
  confirm.addEventListener("click", () => {
    if (selected?.runnable && !selected.disabled) handlers.choose(selected.handle);
  });
  actions.append(confirm);
  card.append(actions);
  return card;
}
