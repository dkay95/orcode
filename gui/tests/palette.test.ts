// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  PALETTE_VISIBLE_ROWS,
  emptyPalette,
  movePalette,
  palettePanel,
  rankCounter,
  selectedRow,
  visibleRows,
  type PaletteRow,
  type PaletteState,
} from "../src/palette.js";

function row(over: Partial<PaletteRow> = {}): PaletteRow {
  return {
    kind: "node",
    command: "/diff",
    name: "/diff",
    description: "Show the current git diff",
    verb: "run",
    presentation: { description: "Git-Änderungen zeigen", actionLabel: "Ausführen" },
    ...over,
  };
}

function state(rows: PaletteRow[], over: Partial<PaletteState> = {}): PaletteState {
  return { ...emptyPalette(), rows, total: rows.length, ...over };
}

function noHandlers() {
  return {
    activate: vi.fn(),
    filter: vi.fn(),
    close: vi.fn(),
    move: vi.fn(),
    up: vi.fn(),
  };
}

describe("the palette", () => {
  it("renders the engine's crumb, not one of its own", () => {
    const { node } = palettePanel(
      state([row()], { crumb: ["Commands", "Workspace"] }),
      noHandlers(),
    );
    expect(node.querySelector(".crumb")!.textContent).toBe("Befehle›Arbeitsbereich");
  });

  it("shows canonical German presentation without raw protocol behavior", () => {
    const rows = [
      row({ command: "/undo", name: "/undo", verb: "insert", presentation: { description: "Rückgängig", actionLabel: "Einfügen" } }),
      row({ command: "/diff", name: "/diff", verb: "run" }),
    ];
    const { node } = palettePanel(state(rows), noHandlers());
    expect(node.textContent).not.toMatch(/\b(insert|run|open)\b/i);
    // Selection starts on the first row, so the Enter hint must say `insert`.
    const chips = [...node.querySelectorAll(".foot > span")].map((n) => n.textContent);
    expect(chips[0]).toBe("EnterEinfügen");
  });

  it("moves the selection with wrap, and the hint follows", () => {
    const rows = [
      row({ command: "/undo", name: "/undo", verb: "insert" }),
      row({ command: "/diff", name: "/diff", verb: "run" }),
    ];
    const live = state(rows);
    const panel = palettePanel(live, noHandlers());
    movePalette(live, -1);
    expect(selectedRow(live)?.verb).toBe("run");
    panel.update();
    expect([...panel.node.querySelectorAll(".foot > span")][0]!.textContent).toBe("EnterAusführen");
    movePalette(live, 1);
    expect(selectedRow(live)?.verb).toBe("insert");
  });

  it("says how many rows it is not showing", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      row({ command: `/c${index}`, name: `/c${index}` }));
    const live = state(many);
    expect(rankCounter(live)).toBe(`${PALETTE_VISIBLE_ROWS} von 20 · ▾`);
    const { node } = palettePanel(live, noHandlers());
    expect(node.querySelectorAll(".prow").length).toBe(PALETTE_VISIBLE_ROWS);
    expect(node.querySelector(".counter")!.textContent).toBe(`${PALETTE_VISIBLE_ROWS} von 20 · ▾`);
  });

  it("shows no counter when nothing is hidden", () => {
    const live = state([row()]);
    expect(rankCounter(live)).toBeNull();
    const { node } = palettePanel(live, noHandlers());
    expect(node.querySelector(".counter")).toBeNull();
  });

  it("keeps the filter field across a redraw", () => {
    const live = state([row()], { query: "un" });
    const panel = palettePanel(live, noHandlers());
    const input = panel.node.querySelector<HTMLInputElement>(".filter")!;
    expect(input.value).toBe("un");
    input.value = "undo";
    live.rows = [row({ command: "/undo", name: "/undo", verb: "insert", presentation: { description: "Rückgängig", actionLabel: "Einfügen" } })];
    panel.update();
    // The list changed; the field the owner is typing into did not.
    expect(panel.node.querySelector<HTMLInputElement>(".filter")!.value).toBe("undo");
    expect(panel.node.querySelector(".verb")!.textContent).toBe("Einfügen");
  });

  it("only offers 'one level up' where there is a level to leave", () => {
    const shallow = palettePanel(state([row()]), noHandlers());
    expect(shallow.node.textContent).not.toContain("eine Ebene zurück");
    const deep = palettePanel(state([row()], { path: ["Workspace"] }), noHandlers());
    expect(deep.node.textContent).toContain("eine Ebene zurück");
  });

  it("activates the row Enter is pointing at", () => {
    const handlers = noHandlers();
    const rows = [row({ command: "/undo", name: "/undo", verb: "insert" }), row()];
    const live = state(rows);
    const { node } = palettePanel(live, handlers);
    const input = node.querySelector<HTMLInputElement>(".filter")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.activate).toHaveBeenCalledWith(rows[0]);
  });

  it("makes disabled rows inert for mouse, Enter, and Tab", () => {
    const handlers = noHandlers();
    const disabled = row({
      presentation: {
        description: "Gesperrt",
        actionLabel: "Ausführen",
        disabled: { code: "run-active", label: "Ein Lauf ist aktiv.", recoveryLabel: "Lauf zuerst beenden" },
      },
    });
    const { node } = palettePanel(state([disabled]), handlers);
    const button = node.querySelector<HTMLButtonElement>(".prow")!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.click();
    const input = node.querySelector<HTMLInputElement>(".filter")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(handlers.activate).not.toHaveBeenCalled();
  });

  it("goes up a level on Backspace only when the field is empty", () => {
    const handlers = noHandlers();
    const { node } = palettePanel(state([row()], { path: ["Workspace"] }), handlers);
    const input = node.querySelector<HTMLInputElement>(".filter")!;
    input.value = "un";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(handlers.up).not.toHaveBeenCalled();
    input.value = "";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(handlers.up).toHaveBeenCalledTimes(1);
  });
});

describe("the palette's visible window", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    row({ command: `/c${index}`, name: `/c${index}` }));

  it("keeps the selection on screen when it walks past the fold", () => {
    const live = state(many);
    // Walk well past the twelfth row — the fixed-prefix render put the
    // cursor off screen here: no marker anywhere and Enter acting on a
    // command nobody could see.
    for (let step = 0; step < 20; step += 1) movePalette(live, 1);
    expect(live.selected).toBe(20);
    const { start, rows } = visibleRows(live);
    expect(rows.length).toBe(PALETTE_VISIBLE_ROWS);
    expect(live.selected).toBeGreaterThanOrEqual(start);
    expect(live.selected).toBeLessThan(start + rows.length);
    const { node } = palettePanel(live, noHandlers());
    const marked = [...node.querySelectorAll(".prow")]
      .filter((entry) => entry.getAttribute("aria-selected") === "true");
    expect(marked.length).toBe(1);
    expect(marked[0]!.textContent).toContain("/c20");
  });

  it("follows a wrap to the last row too", () => {
    const live = state(many);
    movePalette(live, -1);
    expect(live.selected).toBe(39);
    const { start, rows } = visibleRows(live);
    expect(live.selected).toBeGreaterThanOrEqual(start);
    expect(live.selected).toBeLessThan(start + rows.length);
  });

  it("says which side is hidden", () => {
    const live = state(many);
    expect(rankCounter(live)).toBe(`${PALETTE_VISIBLE_ROWS} von 40 · ▾`);
    for (let step = 0; step < 20; step += 1) movePalette(live, 1);
    // Rows hidden above AND below now, and the counter says both.
    expect(rankCounter(live)).toBe(`${PALETTE_VISIBLE_ROWS} von 40 · ▴▾`);
    movePalette(live, -1);
    movePalette(live, 1);
  });
});
