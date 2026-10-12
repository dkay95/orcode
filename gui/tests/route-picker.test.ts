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
    const option = root.querySelector<HTMLButtonElement>("[role='option']")!;
    const confirm = byText(root, "Auswählen");

    expect(option.getAttribute("aria-selected")).toBe("false");
    expect(confirm.disabled).toBe(true);
    expect(choose).not.toHaveBeenCalled();

    option.click();
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(confirm.disabled).toBe(false);
    expect(choose).not.toHaveBeenCalled();

    confirm.click();
    expect(choose).toHaveBeenCalledOnce();
    expect(choose).toHaveBeenCalledWith("route-openrouter-sonnet");
  });

  it.each([
    ["lead", "Lead-Modell und Konto wählen"],
    ["challenger", "Challenger-Modell und Konto wählen"],
  ] as const)("names the explicit %s role before any model is selected", (purpose, heading) => {
    const only = route();
    const choose = vi.fn();
    const root = routePicker(
      { purpose, providers: [provider([only])], routes: [only], canGoBack: true },
      { choose, back: () => {}, cancel: () => {} },
    );

    expect(root.querySelector("h2")?.textContent).toBe(heading);
    expect(root.textContent).toContain("Provider, Konto und Modell bewusst auswählen.");
    expect(root.querySelector("[role='option']")?.getAttribute("aria-selected")).toBe("false");
    expect(byText(root, "Auswählen").disabled).toBe(true);
    expect(choose).not.toHaveBeenCalled();
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
    const option = root.querySelector<HTMLButtonElement>("[role='option']")!;

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
