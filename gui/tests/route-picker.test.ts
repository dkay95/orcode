// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import type {
  DesktopProviderCapability,
  DesktopRouteCandidate,
} from "../src/protocol.js";
import { routePicker } from "../src/route-picker.js";

function route(overrides: Partial<DesktopRouteCandidate> = {}): DesktopRouteCandidate {
  return {
    handle: "route-openrouter-sonnet",
    providerId: "provider-internal-openrouter",
    connectionId: "connection-private-owner",
    accountLabel: "Persönliches Konto",
    canonicalModelId: "anthropic/claude-sonnet-4",
    displayName: "Claude Sonnet 4",
    reasoning: "supported",
    capabilities: ["text", "image-input", "tools", "reasoning", "patch"],
    cost: { kind: "known", label: "Abrechnung nach Nutzung", source: "provider" },
    dataPolicy: { kind: "known", label: "Provider-Richtlinie", source: "provider" },
    runnable: true,
    ...overrides,
  };
}

function provider(
  routes: readonly DesktopRouteCandidate[],
  overrides: Partial<DesktopProviderCapability> = {},
): DesktopProviderCapability {
  return {
    providerId: "provider-internal-openrouter",
    providerLabel: "OpenRouter · Eigentümerkonto",
    connectionId: "connection-private-owner",
    accountLabel: "Persönliches Konto",
    state: "ready",
    setupMethods: ["openrouter-owner-connect"],
    multiProfile: { enabled: false },
    routes,
    ...overrides,
  };
}

function byText(root: HTMLElement, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!match) throw new Error(`no \"${label}\" button in ${root.textContent}`);
  return match;
}

describe("the shared canonical route picker", () => {
  it("shows known and unknown Foundation presentations without translating provider ids", () => {
    const known = route();
    const unknown = route({
      handle: "route-kimi-unknown",
      providerId: "opaque-kimi-provider-id",
      connectionId: "opaque-kimi-connection-id",
      accountLabel: "Mitgliedschaft",
      canonicalModelId: "moonshotai/kimi-k2",
      displayName: "Kimi K2",
      reasoning: "unknown",
      capabilities: ["text", "tools"],
      cost: { kind: "unknown", label: "Kosten unbekannt" },
      dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" },
    });
    const unsupported = route({
      handle: "route-openrouter-basic",
      canonicalModelId: "openrouter/basic",
      displayName: "Basic",
      reasoning: "unsupported",
      capabilities: ["text"],
    });
    const choose = vi.fn();
    const root = routePicker(
      {
        purpose: "main",
        providers: [
          provider([known, unsupported]),
          provider([unknown], {
            providerId: "opaque-kimi-provider-id",
            providerLabel: "Kimi Code · Mitgliedschaft",
            connectionId: "opaque-kimi-connection-id",
            accountLabel: "Mitgliedschaft",
          }),
        ],
        routes: [known, unsupported, unknown],
        canGoBack: true,
      },
      { choose, back: () => {}, cancel: () => {} },
    );

    expect(root.textContent).toContain("OpenRouter · Eigentümerkonto");
    expect(root.textContent).toContain("Persönliches Konto");
    expect(root.textContent).toContain("Claude Sonnet 4");
    expect(root.textContent).toContain("anthropic/claude-sonnet-4");
    expect(root.textContent).toContain("Denkmodus unterstützt");
    expect(root.textContent).toContain("Denkmodus nicht unterstützt");
    expect(root.textContent).toContain("Text");
    expect(root.textContent).toContain("Bildeingabe");
    expect(root.textContent).toContain("Werkzeuge");
    expect(root.textContent).toContain("Dateiänderungen");
    expect(root.textContent).toContain("Abrechnung nach Nutzung");
    expect(root.textContent).toContain("Provider-Richtlinie");
    expect(root.textContent).toContain("Kimi Code · Mitgliedschaft");
    expect(root.textContent).toContain("Denkmodus unbekannt");
    expect(root.textContent).toContain("Kosten unbekannt");
    expect(root.textContent).toContain("Datenrichtlinie unbekannt");

    expect(root.textContent).not.toContain("provider-internal-openrouter");
    expect(root.textContent).not.toContain("opaque-kimi-provider-id");
    expect(root.textContent).not.toContain("supported");
    expect(root.textContent).not.toContain("unknown");
    expect(root.textContent).not.toContain("Reasoning");
    expect(choose).not.toHaveBeenCalled();
  });

  it("requires an explicit runnable row selection even when there is one route", () => {
    const only = route();
    const choose = vi.fn();
    const root = routePicker(
      { purpose: "main", providers: [provider([only])], routes: [only], canGoBack: false },
      { choose, cancel: () => {} },
    );
    const option = root.querySelector<HTMLButtonElement>("button.route-option")!;
    const confirm = byText(root, "Auswählen");

    expect(root.querySelector(".route-picker-list")?.getAttribute("role")).toBe("group");
    expect(option.getAttribute("role")).toBeNull();
    expect(option.getAttribute("aria-pressed")).toBe("false");
    expect(confirm.disabled).toBe(true);
    expect(choose).not.toHaveBeenCalled();

    option.click();
    expect(option.getAttribute("aria-pressed")).toBe("true");
    expect(confirm.disabled).toBe(false);
    expect(choose).not.toHaveBeenCalled();

    confirm.click();
    expect(choose).toHaveBeenCalledOnce();
    expect(choose).toHaveBeenCalledWith("route-openrouter-sonnet");
  });

  it.each([
    ["lead", "Coding-Modell wählen"],
    ["challenger", "Prüfmodell wählen"],
  ] as const)("names the explicit %s role before any model is selected", (purpose, heading) => {
    const only = route();
    const choose = vi.fn();
    const root = routePicker(
      { purpose, providers: [provider([only])], routes: [only], canGoBack: true },
      { choose, back: () => {}, cancel: () => {} },
    );

    expect(root.querySelector("h2")?.textContent).toBe(heading);
    expect(root.textContent).toContain("Provider, Konto und Modell bewusst auswählen.");
    expect(root.querySelector("button.route-option")?.getAttribute("aria-pressed")).toBe("false");
    expect(byText(root, "Auswählen").disabled).toBe(true);
    expect(choose).not.toHaveBeenCalled();
  });

  it("keeps model identity, cost and policy visible while technical facts stay in independent native details", () => {
    const only = route();
    const choose = vi.fn();
    const root = routePicker(
      { purpose: "main", providers: [provider([only])], routes: [only], canGoBack: false },
      { choose, cancel: () => {} },
    );
    const option = root.querySelector<HTMLButtonElement>("button.route-option")!;
    const details = root.querySelector<HTMLDetailsElement>("details");

    expect(option.textContent).toContain("Claude Sonnet 4");
    expect(option.textContent).toContain("OpenRouter · Eigentümerkonto");
    expect(option.textContent).toContain("Persönliches Konto");
    expect(option.textContent).toContain("Abrechnung nach Nutzung");
    expect(option.textContent).toContain("Provider-Richtlinie");
    expect(option.textContent).not.toContain("anthropic/claude-sonnet-4");
    expect(option.textContent).not.toContain("Denkmodus unterstützt");
    expect(option.querySelector("button, details, summary, input")).toBeNull();
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("anthropic/claude-sonnet-4");
    expect(details?.textContent).toContain("Denkmodus unterstützt");
    expect(details?.textContent).toContain("Dateiänderungen");
    expect(details?.querySelector("summary")?.textContent).toContain("Technische Details");

    details!.querySelector("summary")!.click();
    expect(details!.open).toBe(true);
    expect(option.getAttribute("aria-pressed")).toBe("false");
    expect(byText(root, "Auswählen").disabled).toBe(true);
    expect(choose).not.toHaveBeenCalled();
  });

  it.each([
    ["sonnet", ["Claude Sonnet 4"]],
    ["  kimi code  ", ["Kimi K2"]],
    ["geschäftlich", ["Basic"]],
  ])("filters visible choices by model, canonical provider or account name for %s without selecting", (term, names) => {
    const sonnet = route();
    const basic = route({ handle: "route-basic", displayName: "Basic", accountLabel: "Geschäftlich" });
    const kimi = route({ handle: "route-kimi", displayName: "Kimi K2", accountLabel: "Mitgliedschaft" });
    const choose = vi.fn();
    const root = routePicker(
      {
        purpose: "main",
        providers: [provider([sonnet, basic]), provider([kimi], { providerLabel: "Kimi Code" })],
        routes: [sonnet, basic, kimi],
        canGoBack: false,
      },
      { choose, cancel: () => {} },
    );
    const search = root.querySelector<HTMLInputElement>("input[type='search']");
    expect(search).not.toBeNull();
    expect(search!.getAttribute("aria-label")).toBe("Modelle, Provider oder Konten suchen");
    search!.value = term;
    search!.dispatchEvent(new Event("input", { bubbles: true }));

    const visibleOptions = [...root.querySelectorAll<HTMLElement>("button.route-option")]
      .filter((option) => !option.closest("[hidden]"));
    expect(visibleOptions.map((option) => option.querySelector(".route-name")?.textContent)).toEqual(names);
    expect(visibleOptions.every((option) => option.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(byText(root, "Auswählen").disabled).toBe(true);
    expect(choose).not.toHaveBeenCalled();
  });

  it("clears a selection hidden by search and explains the empty result without confirming a route", () => {
    const only = route();
    const choose = vi.fn();
    const root = routePicker(
      { purpose: "main", providers: [provider([only])], routes: [only], canGoBack: false },
      { choose, cancel: () => {} },
    );
    const option = root.querySelector<HTMLButtonElement>("button.route-option")!;
    option.click();
    expect(byText(root, "Auswählen").disabled).toBe(false);

    const search = root.querySelector<HTMLInputElement>("input[type='search']");
    expect(search).not.toBeNull();
    search!.value = "no matching model";
    search!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(option.closest("[hidden]")).not.toBeNull();
    expect(root.querySelector("[role='status']")?.textContent).toBe("Keine Modelle passen zur Suche.");
    expect(root.querySelector("[role='status']")?.closest("[hidden]")).toBeNull();
    expect(option.getAttribute("aria-pressed")).toBe("false");
    expect(byText(root, "Auswählen").disabled).toBe(true);
    byText(root, "Auswählen").click();
    expect(choose).not.toHaveBeenCalled();

    search!.value = "";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(option.closest("[hidden]")).toBeNull();
    expect(option.getAttribute("aria-pressed")).toBe("false");
    expect(byText(root, "Auswählen").disabled).toBe(true);
  });

  it("keeps keyboard navigation within visible runnable choices and requires a separate confirmation", () => {
    const first = route();
    const hidden = route({ handle: "route-basic", displayName: "Basic" });
    const disabled = route({
      handle: "route-disabled-sonnet",
      displayName: "Claude Sonnet unavailable",
      disabled: { code: "account-limit-reached", label: "Kontolimit erreicht" },
    });
    const second = route({ handle: "route-second-sonnet", displayName: "Claude Sonnet second" });
    const choose = vi.fn();
    const root = routePicker(
      { purpose: "main", providers: [provider([first, hidden, disabled, second])], routes: [first, hidden, disabled, second], canGoBack: false },
      { choose, cancel: () => {} },
    );
    document.body.append(root);
    const search = root.querySelector<HTMLInputElement>("input[type='search']");
    expect(search).not.toBeNull();
    search!.value = "sonnet";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    const choices = root.querySelectorAll<HTMLButtonElement>("button.route-option");
    choices[0]!.focus();
    choices[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(document.activeElement).toBe(choices[3]);
    expect(choices[3]!.getAttribute("aria-pressed")).toBe("true");
    expect(choices[1]!.getAttribute("aria-pressed")).toBe("false");
    expect(choices[2]!.getAttribute("aria-pressed")).toBe("false");
    expect(choose).not.toHaveBeenCalled();
    byText(root, "Auswählen").click();
    expect(choose).toHaveBeenCalledWith("route-second-sonnet");
    root.remove();
  });

  it("explains an unrunnable route even without a provider-supplied disabled reason", () => {
    const unavailable = route({ runnable: false });
    const root = routePicker(
      { purpose: "main", providers: [provider([unavailable])], routes: [unavailable], canGoBack: false },
      { choose: () => {}, cancel: () => {} },
    );

    expect(root.querySelector<HTMLButtonElement>("button.route-option")!.disabled).toBe(true);
    expect(root.querySelector("button.route-option")?.textContent).toContain("Nicht verfügbar");
    expect(root.querySelector("details summary")).not.toBeNull();
  });

  it("keeps a canonically disabled route visible and wholly inert", () => {
    const disabled = route({
      handle: "route-disabled",
      runnable: false,
      disabled: {
        code: "account-limit-reached",
        label: "Kontolimit erreicht",
        recoveryLabel: "Später erneut versuchen",
      },
    });
    const choose = vi.fn();
    const root = routePicker(
      { purpose: "main", providers: [provider([disabled])], routes: [disabled], canGoBack: true },
      { choose, back: () => {}, cancel: () => {} },
    );
    const option = root.querySelector<HTMLButtonElement>("button.route-option")!;

    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.disabled).toBe(true);
    expect(root.textContent).toContain("Kontolimit erreicht");
    expect(root.textContent).toContain("Später erneut versuchen");
    expect(root.textContent).not.toContain("account-limit-reached");

    option.click();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(byText(root, "Auswählen").disabled).toBe(true);
    expect(choose).not.toHaveBeenCalled();
  });
});
