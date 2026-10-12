// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import type {
  DesktopOnboardingIntent,
  DesktopOnboardingView,
  DesktopProviderCapability,
  DesktopRouteCandidate,
} from "../src/protocol.js";
import { onboardingView } from "../src/onboarding-view.js";

function route(overrides: Partial<DesktopRouteCandidate> = {}): DesktopRouteCandidate {
  return {
    handle: "route-owner-model",
    providerId: "provider-opaque-owner",
    connectionId: "connection-opaque-owner",
    accountLabel: "Eigentümerkonto",
    canonicalModelId: "anthropic/claude-sonnet-4",
    displayName: "Claude Sonnet 4",
    reasoning: "supported",
    capabilities: ["text", "tools", "reasoning", "patch"],
    cost: { kind: "known", label: "Abrechnung nach Nutzung", source: "provider" },
    dataPolicy: { kind: "known", label: "Provider-Richtlinie", source: "provider" },
    runnable: true,
    ...overrides,
  };
}

function provider(
  overrides: Partial<DesktopProviderCapability> = {},
): DesktopProviderCapability {
  return {
    providerId: "provider-opaque-owner",
    providerLabel: "OpenRouter · Eigentümerkonto",
    connectionId: "connection-opaque-owner",
    accountLabel: "Eigentümerkonto",
    state: "ready",
    setupMethods: ["openrouter-owner-connect"],
    multiProfile: { enabled: false },
    routes: [],
    ...overrides,
  };
}

function view(overrides: Partial<DesktopOnboardingView> = {}): DesktopOnboardingView {
  return {
    revision: 41,
    generation: 7,
    step: "provider",
    returnTo: "chat",
    operationHandle: "operation-private",
    providers: [],
    candidates: [],
    ...overrides,
  };
}

function buttonContaining(root: HTMLElement, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.includes(label),
  );
  if (!match) throw new Error(`no button containing \"${label}\" in ${root.textContent}`);
  return match;
}

describe("the canonical onboarding view", () => {
  it("does not auto-select the only provider", () => {
    const dispatch = vi.fn<(intent: DesktopOnboardingIntent) => void>();
    const root = onboardingView(view({ providers: [provider()] }), { dispatch });

    expect(root.querySelectorAll("[role='option']")).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("renders exactly the projected providers and keeps a disabled Kimi entry inert", () => {
    const dispatch = vi.fn<(intent: DesktopOnboardingIntent) => void>();
    const root = onboardingView(
      view({
        providers: [
          provider(),
          provider({
            providerId: "provider-opaque-kimi",
            providerLabel: "Kimi Code · Mitgliedschaft",
            connectionId: null,
            accountLabel: "Mitgliedschaft",
            state: "disabled",
            setupMethods: ["kimi-owner-connect"],
            disabled: {
              code: "native-local-action-unavailable",
              label: "Lokale Bestätigung ist nicht verfügbar",
              recoveryLabel: "In der Terminal-App verbinden",
            },
          }),
          provider({
            providerId: "provider-opaque-codex",
            providerLabel: "Codex · Browser-Anmeldung",
            connectionId: null,
            accountLabel: null,
            state: "disconnected",
            setupMethods: ["codex-browser-login"],
          }),
        ],
      }),
      { dispatch },
    );

    expect(root.textContent).toContain("OpenRouter · Eigentümerkonto");
    expect(root.textContent).toContain("Kimi Code · Mitgliedschaft");
    expect(root.textContent).toContain("Codex · Browser-Anmeldung");
    expect(root.textContent).toContain("Eigentümerkonto");
    expect(root.textContent).toContain("Bereit");
    expect(root.textContent).toContain("Deaktiviert");
    expect(root.textContent).toContain("Nicht verbunden");
    expect(root.textContent).toContain("Lokale Bestätigung ist nicht verfügbar");
    expect(root.textContent).toContain("In der Terminal-App verbinden");
    expect(root.textContent).not.toContain("provider-opaque");
    expect(root.textContent).not.toContain("native-local-action-unavailable");
    expect(root.textContent).not.toContain("disconnected");
    expect(root.textContent).not.toContain("ready");

    const kimi = buttonContaining(root, "Kimi Code · Mitgliedschaft");
    expect(kimi.getAttribute("aria-disabled")).toBe("true");
    kimi.click();
    expect(dispatch).not.toHaveBeenCalled();

    buttonContaining(root, "OpenRouter · Eigentümerkonto").click();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      kind: "choose-provider",
      providerId: "provider-opaque-owner",
      revision: 41,
      generation: 7,
    });
  });

  it("does not auto-select the only account and dispatches only after its click", () => {
    const dispatch = vi.fn<(intent: DesktopOnboardingIntent) => void>();
    const account = provider();
    const root = onboardingView(
      view({ step: "account", providerId: account.providerId, providers: [account] }),
      { dispatch },
    );

    expect(dispatch).not.toHaveBeenCalled();
    buttonContaining(root, "Eigentümerkonto").click();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      kind: "choose-account",
      connectionId: "connection-opaque-owner",
      revision: 41,
      generation: 7,
    });
  });

  it("requires an explicit route row and confirmation as the third owner action", () => {
    const dispatch = vi.fn<(intent: DesktopOnboardingIntent) => void>();
    const candidate = route();
    const root = onboardingView(
      view({
        step: "model",
        providerId: candidate.providerId,
        connectionId: candidate.connectionId,
        accountLabel: candidate.accountLabel,
        providers: [provider({ routes: [candidate] })],
        candidates: [candidate],
      }),
      { dispatch },
    );
    const confirm = buttonContaining(root, "Auswählen");

    expect(confirm.disabled).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>("button.route-option")!.click();
    expect(dispatch).not.toHaveBeenCalled();
    confirm.click();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      kind: "choose-model",
      routeHandle: "route-owner-model",
      revision: 41,
      generation: 7,
    });
  });

  it("keeps back, cancel, and retry on their canonical revision and generation", () => {
    const dispatch = vi.fn<(intent: DesktopOnboardingIntent) => void>();
    const failed = onboardingView(
      view({
        step: "error",
        error: {
          code: "route-activation-failed",
          label: "Das Modell konnte nicht aktiviert werden",
          recoveryLabel: "Erneut versuchen oder zurückgehen",
        },
      }),
      { dispatch },
    );

    expect(failed.textContent).toContain("Das Modell konnte nicht aktiviert werden");
    expect(failed.textContent).toContain("Erneut versuchen oder zurückgehen");
    expect(failed.textContent).not.toContain("route-activation-failed");

    buttonContaining(failed, "Erneut versuchen").click();
    buttonContaining(failed, "Zurück").click();
    buttonContaining(failed, "Abbrechen").click();
    expect(dispatch.mock.calls.map(([intent]) => intent)).toEqual([
      { kind: "retry", revision: 41, generation: 7 },
      { kind: "back", revision: 41, generation: 7 },
      {
        kind: "cancel",
        revision: 41,
        generation: 7,
        operationHandle: "operation-private",
      },
    ]);
  });

  it("shows canonical repair presentations without leaking their codes", () => {
    const root = onboardingView(
      view({
        providers: [provider({
          state: "degraded",
          repair: {
            code: "account-authentication-required",
            label: "Anmeldung erneuern",
            recoveryLabel: "Konto erneut verbinden",
          },
        })],
      }),
      { dispatch: () => {} },
    );

    expect(root.textContent).toContain("Eingeschränkt");
    expect(root.textContent).toContain("Anmeldung erneuern");
    expect(root.textContent).toContain("Konto erneut verbinden");
    expect(root.textContent).not.toContain("account-authentication-required");
  });
});
