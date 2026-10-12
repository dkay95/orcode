// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
const button = (name: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((candidate) => candidate.textContent?.trim() === name)!;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});
afterEach(() => { mount?.dispose(); mount = null; vi.unstubAllGlobals(); document.body.replaceChildren(); });
async function openWindow(): Promise<FixtureBridge> {
  const root = document.createElement("div"); root.id = "app"; document.body.append(root);
  const bridge = new FixtureBridge(); mount = mountDesktopWindow({ bridge, root });
  await vi.waitFor(() => expect(document.querySelector("textarea")).not.toBeNull());
  return bridge;
}
async function draft(text: string): Promise<void> {
  const field = document.querySelector("textarea")!;
  field.value = text; field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test.each([["Plan erstellen", "/architect"], ["Mit zwei Modellen", "/cross"]])(
  "%s transfers the draft once without automatically selecting a model", async (name, raw) => {
    const bridge = await openWindow(); await draft("  Login verständlicher machen  ");
    expect(button(name)).toBeDefined(); expect(button(name).disabled).toBe(false);
    let resolve!: (value: unknown) => void;
    bridge.commandResult = new Promise((done) => { resolve = done; });
    button(name).click(); button(name).click();
    await vi.waitFor(() => expect(bridge.requests.filter((request) => request.t === "command")).toEqual([
      { t: "command", raw, draft: "Login verständlicher machen" },
    ]));
    expect(document.querySelector("textarea")!.value).toBe("");
    expect(bridge.requests.some((request) => /route\.select|model\.select/.test(String(request.t)))).toBe(false);
    resolve({});
  },
);

test("refused task action restores the draft but does not replace newer typing", async () => {
  const bridge = await openWindow(); await draft("Mein Plan");
  let reject!: (reason: unknown) => void;
  bridge.commandResult = new Promise((_resolve, fail) => { reject = fail; });
  expect(button("Plan erstellen")).toBeDefined(); button("Plan erstellen").click();
  reject(new RequestFailed({ code: "fixture-refusal", message: "fixture command refused" }));
  await vi.waitFor(() => expect(document.querySelector("textarea")!.value).toBe("Mein Plan"));
  await draft("Alter Entwurf");
  bridge.commandResult = new Promise((_resolve, fail) => { reject = fail; });
  button("Plan erstellen").click(); await draft("Schon etwas Neues");
  reject(new RequestFailed({ code: "fixture-refusal", message: "fixture command refused again" }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("fixture command refused again"));
  expect(document.querySelector("textarea")!.value).toBe("Schon etwas Neues");
});

test("inspector uses engine events, preserves open details during streaming, and clears on chat reset", async () => {
  const bridge = await openWindow();
  await vi.waitFor(() => expect(document.querySelector(".workbench-panel")).not.toBeNull());
  const panel = document.querySelector<HTMLElement>(".workbench-panel")!;
  expect(panel.textContent).toContain("Noch keine Änderungen gemeldet.");
  bridge.emit("run", { event: { type: "file-change", path: "src/login.ts", tool: "apply_patch",
    created: false, added: 1, removed: 1, diff: "@@ -1 +1 @@\n-old\n+new", truncated: false } });
  await vi.waitFor(() => expect(panel.textContent).toContain("src/login.ts"));
  const details = panel.querySelector<HTMLDetailsElement>("details")!;
  details.open = true; const summary = details.querySelector("summary")!; summary.focus();
  bridge.emit("assistant", { phase: "delta", delta: "Weiterer Text" });
  await vi.waitFor(() => expect(document.querySelector(".msg-ai")?.textContent).toContain("Weiterer Text"));
  expect(panel.querySelector("details")).toBe(details); expect(details.open).toBe(true);
  expect(document.activeElement).toBe(summary);
  bridge.emit("chat.reset", { chatId: "next", title: "Neue Sitzung", workspace: status.workspace });
  await vi.waitFor(() => expect(panel.textContent).not.toContain("src/login.ts"));
});

test("inspector remains recoverable; undo and busy actions follow engine state", async () => {
  const bridge = await openWindow();
  await vi.waitFor(() => expect(button("Änderungen")).toBeDefined());
  expect(button("Zurücknehmen").disabled).toBe(true);
  bridge.snapshot(true);
  await vi.waitFor(() => expect(button("Zurücknehmen").disabled).toBe(false));
  expect(button("Änderungen").getAttribute("aria-expanded")).toBe("false");
  button("Änderungen").click();
  await vi.waitFor(() => expect(button("Änderungen").getAttribute("aria-expanded")).toBe("true"));
  button("Änderungen").click();
  await vi.waitFor(() => expect(button("Änderungen").getAttribute("aria-expanded")).toBe("false"));
  button("Änderungen").click();
  button("Prüfen").click();
  await vi.waitFor(() => expect(bridge.requests.filter(({ t }) => t === "command")).toEqual([
    { t: "command", raw: "/verify now", draft: "" },
  ]));
  bridge.emit("run", { event: { type: "run-start", model: "fixture" } });
  await vi.waitFor(() => expect(button("Prüfen").disabled).toBe(true));
});

test.each(["Neu getippte Aufgabe", ""])("an authoritative restore does not overwrite newer composer edits (%j)", async (newText) => {
  const bridge = await openWindow(); await draft("Alter Plan");
  let resolve!: (value: unknown) => void;
  bridge.commandResult = new Promise((done) => { resolve = done; });
  button("Plan erstellen").click(); await draft(newText);
  bridge.emit("draft", { text: "Alter Plan", reason: "restore" });
  await new Promise((done) => setTimeout(done, 20));
  expect(document.querySelector("textarea")!.value).toBe(newText);
  resolve({});
});

test("a pending task command allows interjection once the engine reports an active run", async () => {
  const bridge = await openWindow(); await draft("Mein Plan");
  let resolve!: (value: unknown) => void;
  bridge.commandResult = new Promise((done) => { resolve = done; });
  button("Plan erstellen").click();
  bridge.emit("run", { event: { type: "run-start", model: "fixture" } });
  await draft("Bitte auch den Fehlerfall beachten");
  expect(button("Ergänzen").disabled).toBe(false); button("Ergänzen").click();
  await vi.waitFor(() => expect(bridge.requests).toContainEqual({ t: "interject", text: "Bitte auch den Fehlerfall beachten" }));
  resolve({});
});

test("a deferred inspector close cannot steal focus from a remounted window", async () => {
  await openWindow();
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
  document.querySelector<HTMLButtonElement>(".workbench-close")!.click();
  mount!.dispose(); mount = null; document.body.replaceChildren();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  await openWindow();
  callbacks.at(-1)!(0);
  expect(document.activeElement).not.toBe(button("Änderungen"));
});

test("keeps secondary actions in an explicit menu and starts only the owner's written task", async () => {
  const bridge = await openWindow();
  const more = document.querySelector<HTMLDetailsElement>(".composer-actions")!;
  expect(more).not.toBeNull();
  expect(more.open).toBe(false);
  expect(more.querySelector("summary")?.textContent).toBe("Weitere Aktionen");
  expect(more.contains(button("Plan erstellen"))).toBe(true);
  expect(more.contains(button("Mit zwei Modellen"))).toBe(true);
  expect(more.querySelector('button[aria-label="Plan erstellen"]')).toBe(button("Plan erstellen"));
  expect(more.querySelector('button[aria-label="Mit zwei Modellen"]')).toBe(button("Mit zwei Modellen"));
  expect(more.querySelector('button[aria-label="Befehle"]')).toBe(button("Befehle"));
  expect(button("Aufgabe starten").disabled).toBe(true);
  await draft("Login verständlicher machen");
  expect(button("Aufgabe starten").disabled).toBe(false);
  button("Aufgabe starten").click();
  await vi.waitFor(() => expect(bridge.requests).toContainEqual({ t: "submit", text: "Login verständlicher machen" }));
  expect(bridge.requests.some(({ t }) => /route\.select|model\.select/.test(String(t)))).toBe(false);
});

test("preserves the opened status disclosure and its keyboard focus through live updates", async () => {
  const bridge = await openWindow();
  const details = document.querySelector<HTMLDetailsElement>(".status-details")!;
  const summary = details.querySelector("summary")!;
  details.open = true; summary.focus();
  bridge.emit("status", { text: "Werkzeug läuft", busy: true });
  await vi.waitFor(() => expect(document.querySelector(".statusbar")?.textContent).toContain("Werkzeug läuft"));
  expect(document.querySelector(".status-details")).toBe(details);
  expect(details.open).toBe(true);
  expect(document.activeElement).toBe(summary);
});

test("keeps the secondary-action disclosure mounted while draft availability changes", async () => {
  await openWindow();
  const menu = document.querySelector<HTMLDetailsElement>(".composer-actions")!;
  const summary = menu.querySelector("summary")!;
  menu.open = true; summary.focus();
  await draft("Mein neuer Entwurf");
  expect(document.querySelector(".composer-actions")).toBe(menu);
  expect(menu.open).toBe(true);
  expect(document.activeElement).toBe(summary);
});
