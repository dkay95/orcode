// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

test("the standalone demo mounts the production UI without a native engine or real accounts", async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="preview-app"></div>';
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  const { demoMount } = await import("../preview/workbench-demo.js");
  try {
    await vi.waitFor(() => expect(document.querySelector(".workbench-panel")?.textContent).toContain("src/auth/login.ts"));
    expect(document.querySelector(".route-current")?.textContent).toContain("Demo · keine Verbindung");
    expect(document.querySelector(".workbench-panel")?.textContent).toContain("kein Test wurde tatsächlich ausgeführt");
    const input = document.querySelector("textarea")!;
    input.value = "Eine Demo-Aufgabe";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const send=()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Aufgabe starten')!;
    await vi.waitFor(() => expect(send().disabled).toBe(false));
    send().click();
    await vi.waitFor(() => expect(input.value).toBe(""));
    await vi.waitFor(() => expect(document.querySelector(".stream")?.textContent).toContain("Vorschau"));
  } finally {
    demoMount.dispose(); vi.unstubAllGlobals(); document.body.replaceChildren();
  }
});

test("the demo header opens two unselected synthetic routes and changes only the local demo route after confirmation", async () => {
  vi.resetModules();
  document.body.innerHTML = '<div id="preview-app"></div>';
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  const { demoMount } = await import("../preview/workbench-demo.js");
  try {
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>(".route-change")?.disabled).toBe(false));
    const originalRoute = document.querySelector(".route-current")!.textContent;
    document.querySelector<HTMLButtonElement>(".route-change")!.click();
    await vi.waitFor(() => expect(document.querySelector(".route-picker")).not.toBeNull());
    const picker = document.querySelector<HTMLElement>(".route-picker")!;
    const choices = [...picker.querySelectorAll<HTMLButtonElement>("button.route-option")];
    expect(choices.map((choice) => choice.querySelector(".route-name")?.textContent)).toEqual(["Demo Modell A", "Demo Modell B"]);
    expect(choices.map((choice) => choice.querySelector(".route-account")?.textContent)).toEqual(["Demo-Konto A", "Demo-Konto B"]);
    expect(choices.every((choice) => choice.getAttribute("aria-pressed") === "false")).toBe(true);
    const confirm = [...picker.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Auswählen")!;
    expect(confirm.disabled).toBe(true);
    expect(document.querySelector(".route-current")!.textContent).toBe(originalRoute);

    const search = picker.querySelector<HTMLInputElement>("input[type='search']")!;
    search.value = "Demo-Konto B";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(choices[0]!.closest("[hidden]")).not.toBeNull();
    expect(choices[1]!.closest("[hidden]")).toBeNull();
    expect(confirm.disabled).toBe(true);
    choices[1]!.click();
    expect(confirm.disabled).toBe(false);
    expect(document.querySelector(".route-current")!.textContent).toBe(originalRoute);
    confirm.click();
    await vi.waitFor(() => expect(document.querySelector(".route-picker")).toBeNull());
    await vi.waitFor(() => expect(document.querySelector(".route-current")?.textContent).toContain("Demo Modell B"));
    expect(document.querySelector(".route-current")?.textContent).toContain("Demo-Konto B");
    expect(document.activeElement).toBe(document.querySelector(".route-change"));

    document.querySelector<HTMLButtonElement>(".route-change")!.click();
    await vi.waitFor(() => expect(document.querySelectorAll(".route-picker button.route-option")).toHaveLength(2));
    expect([...document.querySelectorAll(".route-picker button.route-option")]
      .every((choice) => choice.getAttribute("aria-pressed") === "false")).toBe(true);
    const cancel = [...document.querySelectorAll<HTMLButtonElement>(".route-picker button")]
      .find((button) => button.textContent === "Abbrechen")!;
    cancel.click();
    await vi.waitFor(() => expect(document.querySelector(".route-picker")).toBeNull());
    expect(document.querySelector(".route-current")?.textContent).toContain("Demo Modell B");
    expect(document.querySelector(".stream")?.textContent).not.toContain("Diese Funktion braucht die echte orcode-Engine");
  } finally {
    demoMount.dispose(); vi.unstubAllGlobals(); document.body.replaceChildren();
  }
});
