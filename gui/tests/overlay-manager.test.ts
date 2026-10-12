// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayManager } from "../src/overlay-manager.js";

function button(label: string, attributes: Record<string, string> = {}): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function dialog(
  labelId: string,
  controls: readonly HTMLElement[],
): HTMLElement {
  const node = document.createElement("section");
  const heading = document.createElement("h2");
  heading.id = labelId;
  heading.textContent = "Modell auswählen";
  node.append(heading, ...controls);
  return node;
}

function pressTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

describe("OverlayManager", () => {
  let app: HTMLElement;
  let host: HTMLElement;
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    app = document.createElement("main");
    host = document.createElement("div");
    trigger = button("Modell ändern");
    app.append(trigger);
    document.body.replaceChildren(app, host);
    trigger.focus();
  });

  it("makes the app inert, traps Tab in both directions, and restores focus", () => {
    const manager = new OverlayManager(app, host);
    const safe = button("Abbrechen", { "data-overlay-safe-action": "" });
    const hidden = button("Unsichtbar");
    hidden.hidden = true;
    const disabled = button("Deaktiviert");
    disabled.disabled = true;
    const choose = button("Auswählen");

    const handle = manager.open({
      id: "model",
      trigger,
      labelId: "model-title",
      initialFocus: "safe-action",
      onDismiss: vi.fn(),
      render: () => dialog("model-title", [safe, hidden, disabled, choose]),
    });

    const mounted = host.querySelector<HTMLElement>("[role='dialog']");
    expect(mounted).not.toBeNull();
    expect(mounted?.getAttribute("aria-modal")).toBe("true");
    expect(mounted?.getAttribute("aria-labelledby")).toBe("model-title");
    expect(mounted?.querySelector("#model-title")?.textContent).toBe("Modell auswählen");
    expect(app.inert).toBe(true);
    expect(app.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).toBe(safe);

    choose.focus();
    expect(pressTab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(safe);

    safe.focus();
    expect(pressTab(true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(choose);

    handle.close();
    expect(app.inert).toBe(false);
    expect(app.hasAttribute("aria-hidden")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("latches Escape dismissal before a second key event can repeat it", () => {
    const manager = new OverlayManager(app, host);
    const dismiss = vi.fn();
    const safe = button("Ablehnen", { "data-overlay-safe-action": "" });
    const allow = button("Erlauben", { "data-danger": "" });
    const consequential = vi.fn();
    allow.addEventListener("click", consequential);
    manager.open({
      id: "approval",
      trigger,
      labelId: "approval-title",
      initialFocus: "safe-action",
      onDismiss: dismiss,
      render: () => dialog("approval-title", [safe, allow]),
    });

    const escape = (): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
      return event;
    };
    const first = escape();
    const second = escape();

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(consequential).not.toHaveBeenCalled();
  });

  it("restores the exact prior modal control when nested overlays close", () => {
    const manager = new OverlayManager(app, host);
    const firstSafe = button("Erste sichere Aktion", { "data-overlay-safe-action": "" });
    const nestedTrigger = button("Details öffnen");
    const first = manager.open({
      id: "first",
      trigger,
      labelId: "first-title",
      initialFocus: "safe-action",
      onDismiss: vi.fn(),
      render: () => dialog("first-title", [firstSafe, nestedTrigger]),
    });
    nestedTrigger.focus();

    const secondSafe = button("Schließen", { "data-overlay-safe-action": "" });
    const second = manager.open({
      id: "second",
      trigger: nestedTrigger,
      labelId: "second-title",
      initialFocus: "safe-action",
      onDismiss: vi.fn(),
      render: () => dialog("second-title", [secondSafe]),
    });
    expect(document.activeElement).toBe(secondSafe);

    second.close();
    expect(app.inert).toBe(true);
    expect(document.activeElement).toBe(nestedTrigger);

    first.close();
    expect(app.inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps one deduplicated polite and assertive live region without moving focus", () => {
    const manager = new OverlayManager(app, host);
    const status = host.querySelector<HTMLElement>("[role='status']");
    const alert = host.querySelector<HTMLElement>("[role='alert']");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(alert?.getAttribute("aria-live")).toBe("assertive");

    manager.announce("Bereit", "polite");
    const firstStatusText = status?.firstChild;
    manager.announce("Bereit", "polite");
    expect(status?.firstChild).toBe(firstStatusText);
    expect(status?.textContent).toBe("Bereit");

    manager.announce("Freigabe erforderlich", "assertive");
    manager.announce("Freigabe erforderlich", "assertive");
    expect(alert?.textContent).toBe("Freigabe erforderlich");
    expect(document.activeElement).toBe(trigger);

    manager.destroy();
    expect(host.querySelector("[role='status']")).toBeNull();
    expect(host.querySelector("[role='alert']")).toBeNull();
  });
});
