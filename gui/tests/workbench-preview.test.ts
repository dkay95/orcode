// @vitest-environment jsdom
import { expect, test, vi } from "vitest";

test("the standalone demo mounts the production UI without a native engine or real accounts", async () => {
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
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>(".task-action")!.disabled).toBe(false));
    document.querySelector<HTMLButtonElement>(".task-action")!.click();
    await vi.waitFor(() => expect(input.value).toBe("Eine Demo-Aufgabe"));
    await vi.waitFor(() => expect(document.querySelector(".stream")?.textContent).toContain("Hier wird nichts ausgeführt"));
  } finally {
    demoMount.dispose(); vi.unstubAllGlobals(); document.body.replaceChildren();
  }
});
