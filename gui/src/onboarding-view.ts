/**
 * Visible desktop onboarding, projected entirely from DesktopOnboardingView.
 *
 * The engine owns provider/account/model availability and every diagnostic.
 * This renderer owns only layout, German control chrome, and the explicit
 * owner actions that become canonical onboarding intents.
 */

import { el } from "./dom.js";
import type {
  DesktopDisabledPresentation,
  DesktopOnboardingIntent,
  DesktopOnboardingView,
  DesktopProviderCapability,
  DesktopProviderState,
} from "./protocol.js";
import { routePicker } from "./route-picker.js";

export interface OnboardingViewHandlers {
  dispatch(intent: DesktopOnboardingIntent): void;
}

const STATE_LABELS: Readonly<Record<DesktopProviderState, string>> = {
  disconnected: "Nicht verbunden",
  connecting: "Verbindung wird hergestellt",
  ready: "Bereit",
  degraded: "Eingeschränkt",
  disabled: "Deaktiviert",
  blocked: "Blockiert",
};

function presentation(
  value: DesktopDisabledPresentation | undefined,
  className: string,
): HTMLElement[] {
  if (!value) return [];
  return [
    el("span", { class: `${className}-label`, text: value.label }),
    ...(value.recoveryLabel
      ? [el("span", { class: `${className}-recovery`, text: value.recoveryLabel })]
      : []),
  ];
}

function cancelIntent(view: DesktopOnboardingView): DesktopOnboardingIntent {
  const base = {
    kind: "cancel" as const,
    revision: view.revision,
    generation: view.generation,
  };
  return view.operationHandle ? { ...base, operationHandle: view.operationHandle } : base;
}

function actionButton(
  label: string,
  action: () => void,
  options: { readonly primary?: boolean; readonly safe?: boolean } = {},
): HTMLButtonElement {
  const button = el("button", {
    class: `btn ${options.primary ? "primary" : "ghost"}`,
    type: "button",
    text: label,
    "data-overlay-safe-action": options.safe ? "" : undefined,
  }) as HTMLButtonElement;
  button.addEventListener("click", action);
  return button;
}

function actionBar(
  view: DesktopOnboardingView,
  handlers: OnboardingViewHandlers,
  options: { readonly back?: boolean; readonly retry?: boolean } = {},
): HTMLElement {
  const actions = el("div", { class: "actions onboarding-actions" });
  actions.append(actionButton("Abbrechen", () => handlers.dispatch(cancelIntent(view)), { safe: true }));
  if (options.back) {
    actions.append(actionButton("Zurück", () => handlers.dispatch({
      kind: "back",
      revision: view.revision,
      generation: view.generation,
    })));
  }
  if (options.retry) {
    actions.append(actionButton("Erneut versuchen", () => handlers.dispatch({
      kind: "retry",
      revision: view.revision,
      generation: view.generation,
    }), { primary: true }));
  }
  return actions;
}

function providerFacts(provider: DesktopProviderCapability): HTMLElement[] {
  return [
    el("strong", { class: "onboarding-provider-label", text: provider.providerLabel }),
    ...(provider.accountLabel
      ? [el("span", { class: "onboarding-account-label", text: provider.accountLabel })]
      : []),
    el("span", { class: "onboarding-provider-state", text: STATE_LABELS[provider.state] }),
    ...presentation(provider.disabled, "onboarding-disabled"),
    ...presentation(provider.repair, "onboarding-repair"),
  ];
}

function providerStep(
  view: DesktopOnboardingView,
  handlers: OnboardingViewHandlers,
): HTMLElement {
  const card = el("section", { class: "modal onboarding-view onboarding-provider-view" });
  card.append(el("h2", { text: "Provider wählen", "data-overlay-heading": "" }));
  card.append(el("p", { class: "onboarding-intro", text: "Wähle den Provider, den du verwenden möchtest." }));
  const list = el("div", { class: "onboarding-list", role: "listbox", "aria-label": "Provider" });

  for (const provider of view.providers) {
    const disabled = provider.disabled !== undefined;
    const row = el("button", {
      class: `onboarding-option${disabled ? " is-disabled" : ""}`,
      type: "button",
      role: "option",
      "aria-selected": "false",
      "aria-disabled": disabled ? "true" : undefined,
      disabled,
    }, providerFacts(provider)) as HTMLButtonElement;
    if (!disabled) {
      row.addEventListener("click", () => handlers.dispatch({
        kind: "choose-provider",
        providerId: provider.providerId,
        revision: view.revision,
        generation: view.generation,
      }));
    }
    list.append(row);
  }
  if (view.providers.length === 0) list.append(el("p", { class: "empty", text: "Keine Provider verfügbar." }));
  card.append(list, actionBar(view, handlers));
  return card;
}

function accountStep(
  view: DesktopOnboardingView,
  handlers: OnboardingViewHandlers,
): HTMLElement {
  const card = el("section", { class: "modal onboarding-view onboarding-account-view" });
  card.append(el("h2", { text: "Konto wählen", "data-overlay-heading": "" }));
  card.append(el("p", { class: "onboarding-intro", text: "Wähle das Konto für diesen Provider." }));
  const list = el("div", { class: "onboarding-list", role: "listbox", "aria-label": "Konten" });
  const accounts = view.providers.filter((provider) => provider.providerId === view.providerId);

  for (const account of accounts) {
    const disabled = account.disabled !== undefined || account.connectionId === null;
    const row = el("button", {
      class: `onboarding-option${disabled ? " is-disabled" : ""}`,
      type: "button",
      role: "option",
      "aria-selected": "false",
      "aria-disabled": disabled ? "true" : undefined,
      disabled,
    }, providerFacts(account)) as HTMLButtonElement;
    if (!disabled && account.connectionId) {
      row.addEventListener("click", () => handlers.dispatch({
        kind: "choose-account",
        connectionId: account.connectionId!,
        revision: view.revision,
        generation: view.generation,
      }));
    }
    list.append(row);
  }
  if (accounts.length === 0) list.append(el("p", { class: "empty", text: "Keine Konten verfügbar." }));
  card.append(list, actionBar(view, handlers, { back: true }));
  return card;
}

function errorStep(
  view: DesktopOnboardingView,
  handlers: OnboardingViewHandlers,
): HTMLElement {
  const card = el("section", { class: "modal onboarding-view onboarding-error-view" });
  card.append(el("h2", { text: "Auswahl nicht abgeschlossen", "data-overlay-heading": "" }));
  if (view.error) card.append(...presentation(view.error, "onboarding-error"));
  card.append(actionBar(view, handlers, { back: true, retry: true }));
  return card;
}

function passiveStep(
  view: DesktopOnboardingView,
  handlers: OnboardingViewHandlers,
): HTMLElement {
  const ready = view.step === "ready";
  const card = el("section", { class: "modal onboarding-view" });
  card.append(el("h2", {
    text: ready ? "Auswahl bestätigt" : "Auswahl wird verarbeitet",
    "data-overlay-heading": "",
  }));
  card.append(actionBar(view, handlers));
  return card;
}

export function onboardingView(
  view: DesktopOnboardingView,
  handlers: OnboardingViewHandlers,
): HTMLElement {
  if (view.step === "provider") return providerStep(view, handlers);
  if (view.step === "account") return accountStep(view, handlers);
  if (view.step === "model") {
    return routePicker(
      { purpose: "main", providers: view.providers, routes: view.candidates, canGoBack: true },
      {
        choose: (routeHandle) => handlers.dispatch({
          kind: "choose-model",
          routeHandle,
          revision: view.revision,
          generation: view.generation,
        }),
        back: () => handlers.dispatch({
          kind: "back",
          revision: view.revision,
          generation: view.generation,
        }),
        cancel: () => handlers.dispatch(cancelIntent(view)),
      },
    );
  }
  if (view.step === "error") return errorStep(view, handlers);
  return passiveStep(view, handlers);
}
