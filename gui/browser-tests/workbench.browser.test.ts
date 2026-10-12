import { page, userEvent } from "@vitest/browser/context";
import { afterEach, expect, test } from "vitest";
import { RequestFailed, type BridgeHandlers } from "../src/bridge.js";
import { mountDesktopWindow, type DesktopWindowBridge, type DesktopWindowMount } from "../src/main.js";
import { PROTOCOL_VERSION, type GuiStatus, type ServerFrame } from "../src/protocol.js";

const status: GuiStatus = {
  model: "fixture", resolvedModel: "fixture", workspace: "/tmp/workbench-project",
  chatId: "workbench-chat", chatTitle: "Login überarbeiten", approval: "ask",
  routeConnected: true, providerManaged: false, balanceHedged: true,
  lowBalanceThresholdUsd: 1, sessionUsd: 0, sessionCostKnowledge: "unknown",
  balanceRemainingUsd: undefined, dayUsd: undefined,
  runActive: false, executionMode: "desktop", ownerPathsAllowed: false,
};
class FixtureBridge implements DesktopWindowBridge {
  handlers!: BridgeHandlers;
  requests: Array<Record<string, unknown>> = [];
  commandResult: Promise<unknown> | null = null;
  async start(handlers: BridgeHandlers) {
    this.handlers = handlers;
    queueMicrotask(() => handlers.onFrame({ t: "hello", v: PROTOCOL_VERSION,
      protocol: PROTOCOL_VERSION, orcode: "0.7.0", node: "fixture", pid: 1, capabilities: [] }));
    return { node: "fixture", script: "fixture", workspace: status.workspace,
      home: "/tmp/workbench-home", realHome: false, pid: 1 };
  }
  async request<T>(t: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ t, ...payload });
    if (t === "status.get") return status as T;
    if (t === "chats.list") return { chats: [] } as T;
    if (t === "desktop.snapshot.get") this.snapshot(false);
    if (t === "command" && this.commandResult) return await this.commandResult as T;
    return {} as T;
  }
  async write(): Promise<void> {}
  emit(e: string, payload: Record<string, unknown>): void {
    this.handlers.onFrame({ t: "event", v: PROTOCOL_VERSION, e, ...payload } as ServerFrame);
  }
  snapshot(undoAvailable: boolean): void {
    this.emit("desktop.snapshot", { snapshot: { schemaVersion: 1, revision: undoAvailable ? 8 : 7,
      generation: 3, routeRunnable: true, activeRoute: null, providers: [], undoAvailable,
      appearance: { showLargeLogo: true, showHeaderMark: true } } });
  }
}
let mount: DesktopWindowMount | null = null;
async function openWindow(): Promise<FixtureBridge> {
  await page.viewport(1440, 900);
  document.body.replaceChildren();
  const root = document.createElement("div"); root.id = "app"; document.body.append(root);
  const bridge = new FixtureBridge(); mount = mountDesktopWindow({ bridge, root });
  await expect.poll(() => document.querySelector("textarea")).not.toBeNull();
  return bridge;
}
afterEach(async () => { mount?.dispose(); mount = null; await page.viewport(1280, 720); });
const button = (name: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((candidate) => candidate.textContent?.trim() === name)!;
async function draft(text: string): Promise<void> {
  const field = document.querySelector("textarea")!;
  field.value = text; field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

test.each([["Plan erstellen", "/architect"], ["Mit zwei Modellen", "/cross"]])(
  "%s transfers the owner's draft exactly once without selecting models", async (name, raw) => {
    const bridge = await openWindow();
    await draft("  Login verständlicher machen  ");
    expect(button(name)).toBeDefined();
    expect(button(name).disabled).toBe(false);
    let resolve!: (value: unknown) => void;
    bridge.commandResult = new Promise((done) => { resolve = done; });
    button(name).click(); button(name).click();
    await expect.poll(() => bridge.requests.filter((request) => request.t === "command")).toEqual([
      { t: "command", raw, draft: "Login verständlicher machen" },
    ]);
    expect(document.querySelector("textarea")!.value).toBe("");
    expect(bridge.requests.some((request) => /route\.select|model\.select/.test(String(request.t)))).toBe(false);
    resolve({});
  },
);

test("refused task action restores the draft without replacing newer typing", async () => {
  const bridge = await openWindow();
  await draft("Mein Plan");
  let reject!: (reason: unknown) => void;
  bridge.commandResult = new Promise((_resolve, fail) => { reject = fail; });
  expect(button("Plan erstellen")).toBeDefined();
  button("Plan erstellen").click();
  reject(new RequestFailed({ code: "fixture-refusal", message: "fixture command refused" }));
  await expect.poll(() => document.querySelector("textarea")!.value).toBe("Mein Plan");
  await draft("Alter Entwurf");
  bridge.commandResult = new Promise((_resolve, fail) => { reject = fail; });
  button("Plan erstellen").click();
  await draft("Schon etwas Neues");
  reject(new RequestFailed({ code: "fixture-refusal", message: "fixture command refused again" }));
  await expect.poll(() => document.querySelector(".notice")?.textContent ?? document.body.textContent)
    .toContain("fixture command refused again");
  expect(document.querySelector("textarea")!.value).toBe("Schon etwas Neues");
});

test("inspector reflects real events, keeps file detail focus, and clears on chat reset", async () => {
  const bridge = await openWindow();
  await expect.poll(() => document.querySelector(".workbench-panel")).not.toBeNull();
  const panel = document.querySelector<HTMLElement>(".workbench-panel")!;
  expect(panel.textContent).toContain("Noch keine Änderungen gemeldet.");
  bridge.emit("run", { event: { type: "file-change", path: "src/login.ts", tool: "apply_patch",
    created: false, added: 1, removed: 1, diff: "@@ -1 +1 @@\n-old\n+new", truncated: false } });
  await expect.poll(() => panel.textContent).toContain("src/login.ts");
  const details = panel.querySelector<HTMLDetailsElement>("details")!;
  const summary = details.querySelector("summary")!;
  summary.focus(); await userEvent.keyboard("{Enter}");
  bridge.emit("assistant", { phase: "delta", delta: "Weiterer Text" });
  await expect.poll(() => document.querySelector(".msg-ai")?.textContent).toContain("Weiterer Text");
  expect(panel.querySelector("details")).toBe(details);
  expect(details.open).toBe(true); expect(document.activeElement).toBe(summary);
  bridge.emit("chat.reset", { chatId: "next", title: "Neue Sitzung", workspace: status.workspace });
  await expect.poll(() => panel.textContent).not.toContain("src/login.ts");
});

test("inspector can be closed and recovered at the minimum width; undo follows engine authority", async () => {
  const bridge = await openWindow();
  await page.viewport(760, 520);
  await expect.poll(() => button("Arbeitsstand")).toBeDefined();
  expect(button("Zurücknehmen").disabled).toBe(true);
  bridge.snapshot(true);
  await expect.poll(() => button("Zurücknehmen").disabled).toBe(false);
  button("Arbeitsstand").click();
  await expect.poll(() => button("Arbeitsstand").getAttribute("aria-expanded")).toBe("false");
  button("Arbeitsstand").click();
  await expect.poll(() => button("Arbeitsstand").getAttribute("aria-expanded")).toBe("true");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(760);
  button("Prüfen").click();
  await expect.poll(() => bridge.requests.filter(({ t }) => t === "command")).toEqual([
    { t: "command", raw: "/verify now", draft: "" },
  ]);
  bridge.emit("run", { event: { type: "run-start", model: "fixture" } });
  await expect.poll(() => button("Prüfen").disabled).toBe(true);
});
