// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { normalizeCatalogQuery, slashCompletionPanel, type SlashCompletionState } from "../src/slash-complete.js";
import type { GuiPaletteRow } from "../src/protocol.js";

const rows: GuiPaletteRow[] = ["compress", "context", "cost", "cross"].map((name) => ({
  kind: "match", command: `/${name}`, name: `/${name}`, usage: `/${name}`,
  description: "legacy", verb: name === "cross" ? "insert" : "run",
  presentation: { description: `Deutsch ${name}`, actionLabel: name === "cross" ? "Einfügen" : "Ausführen" },
}));

describe("catalog-backed slash completion", () => {
  it("normalizes one optional leading slash", () => {
    expect(normalizeCatalogQuery("/co")).toBe("co");
    expect(normalizeCatalogQuery("co")).toBe("co");
  });

  it("renders canonical German presentation and exposes the selected row", () => {
    const state: SlashCompletionState = { raw: "/co", rows, selected: 2 };
    const choose = vi.fn();
    const node = slashCompletionPanel(state, { choose });
    expect([...node.querySelectorAll('[role="option"]')].map((entry) => entry.querySelector(".usage")?.textContent))
      .toEqual(["/compress", "/context", "/cost", "/cross"]);
    expect(node.textContent).not.toContain("legacy");
    expect(node.textContent).not.toMatch(/\b(run|insert|open)\b/i);
    (node.querySelectorAll("button")[2] as HTMLButtonElement).click();
    expect(choose).toHaveBeenCalledWith(rows[2]);
  });

  it("renders a disabled suggestion as an inert control", () => {
    const choose = vi.fn();
    const disabled = {
      ...rows[0]!,
      presentation: {
        ...rows[0]!.presentation,
        disabled: { code: "run-active" as const, label: "Ein Lauf ist aktiv.", recoveryLabel: "Lauf zuerst beenden" },
      },
    };
    const node = slashCompletionPanel({ raw: "/co", rows: [disabled], selected: 0 }, { choose });
    const button = node.querySelector<HTMLButtonElement>("button")!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.click();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(choose).not.toHaveBeenCalled();
  });
});
