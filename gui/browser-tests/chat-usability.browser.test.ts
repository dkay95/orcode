import { page, userEvent } from "@vitest/browser/context";
import { afterEach, expect, test } from "vitest";

import type { BridgeHandlers } from "../src/bridge.js";
import { mountDesktopWindow, type DesktopWindowMount, type DesktopWindowBridge } from "../src/main.js";
import { PROTOCOL_VERSION, type GuiStatus, type ServerFrame } from "../src/protocol.js";

// Only the external engine is substituted. Events drive the production
// controller, browser DOM, native details toggles, layout and keyboard paths.
const status: GuiStatus = {
  model: "", resolvedModel: "", workspace: "/tmp/orcode-usability-fixture",
  chatId: "fixture-chat", chatTitle: "Neuer Chat", approval: "ask",
  routeConnected: false, providerManaged: false, balanceHedged: true,
  lowBalanceThresholdUsd: 1, sessionUsd: 0, sessionCostKnowledge: "unknown",
  runActive: false, executionMode: "desktop", ownerPathsAllowed: false,
};

class FixtureBridge implements DesktopWindowBridge {
  handlers!: BridgeHandlers;
  requests: Array<Record<string, unknown>> = [];
  forecasts: Array<Promise<unknown>> = [];
  async start(handlers: BridgeHandlers) {
    this.handlers = handlers;
    queueMicrotask(() => handlers.onFrame({
      t: "hello", v: PROTOCOL_VERSION, protocol: PROTOCOL_VERSION,
      orcode: "0.7.0", node: "fixture", pid: 1, capabilities: [],
    }));
    return { node: "fixture", script: "fixture", workspace: status.workspace,
      home: "/tmp/orcode-usability-fixture/home", realHome: false, pid: 1 };
  }
  async request<T>(t: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ t, ...payload });
    if (t === "status.get") return status as T;
    if (t === "chats.list") return { chats: [] } as T;
    if (t === "desktop.snapshot.get") {
      this.emit("desktop.snapshot", { snapshot: {
        schemaVersion: 1, revision: 7, generation: 3, routeRunnable: true,
        activeRoute: null, providers: [], undoAvailable: false,
        appearance: { showLargeLogo: true, showHeaderMark: true },
      } });
    }
    if (t === "cost.forecast") return await (this.forecasts.shift()
      ?? Promise.resolve(payload.draftChars ? { kind: "known", text: "~$0.01–0.02" } : { kind: "none" })) as T;
    return {} as T;
  }
  async write(): Promise<void> {}
  emit(e: string, payload: Record<string, unknown> = {}): void {
    this.handlers.onFrame({ t: "event", v: PROTOCOL_VERSION, e, ...payload } as ServerFrame);
  }
}

let mount: DesktopWindowMount | null = null;
async function openWindow(): Promise<FixtureBridge> {
  await page.viewport(1000, 760);
  document.body.replaceChildren();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FixtureBridge();
  mount = mountDesktopWindow({ bridge, root });
  await expect.poll(() => document.querySelector("textarea")).not.toBeNull();
  return bridge;
}
afterEach(async () => { mount?.dispose(); mount = null; await page.viewport(1280, 720); });

async function paint(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

test("new transcript content follows the bottom but preserves an intentional scroll-away", async () => {
  const bridge = await openWindow();
  bridge.emit("transcript", { role: "user", content: "Vorherige Zeile\n".repeat(70) });
  await paint();
  const content = document.querySelector<HTMLElement>(".content")!;
  content.scrollTop = content.scrollHeight;
  bridge.emit("transcript", { role: "user", content: "Neue Zeile\n".repeat(35) });
  await paint();
  expect(content.scrollHeight - content.clientHeight - content.scrollTop).toBeLessThan(2);
  content.scrollTop = 100;
  bridge.emit("transcript", { role: "assistant", content: "Weitere Antwort\n".repeat(20) });
  await paint();
  expect(content.scrollTop).toBe(100);
});

test.each(["reasoning", "tool"])("expanded %s retains open state and keyboard focus while output changes", async (kind) => {
  const bridge = await openWindow();
  bridge.emit("run", { event: { type: "run-start", model: "fixture" } });
  if (kind === "reasoning") bridge.emit("run", { event: { type: "reasoning", delta: "Erster Gedanke" } });
  else {
    bridge.emit("run", { event: { type: "tool-start", id: "tool-1", name: "run_command", input: { command: "fixture" } } });
    bridge.emit("run", { event: { type: "tool-output", id: "tool-1", text: "Erste Zeile\n" } });
  }
  await paint();
  const selector = kind === "reasoning" ? "details.thinking" : "details.toolcard";
  const details = document.querySelector<HTMLDetailsElement>(selector)!;
  const summary = details.querySelector("summary")!;
  summary.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => details.open).toBe(true);
  for (let index = 0; index < 3; index += 1) {
    bridge.emit("run", { event: kind === "reasoning"
      ? { type: "reasoning", delta: ` Gedanke ${index}` }
      : { type: "tool-output", id: "tool-1", text: `Zeile ${index}\n` } });
    await paint();
    expect(document.querySelector(selector)).toBe(details);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary);
  }
});

test("pending attachments are visible and disappear only when the engine clears them", async () => {
  const bridge = await openWindow();
  bridge.emit("attachments", { files: [
    { name: "plan.png", mimeType: "image/png", sizeBytes: 2048 },
    { name: "detail.jpg", mimeType: "image/jpeg", sizeBytes: 4096 },
  ] });
  await expect.poll(() => document.querySelector(".composer-attachments")?.textContent).toContain("plan.png");
  expect(document.querySelector(".composer-attachments")?.textContent).toContain("detail.jpg");
  expect(document.querySelector(".composer-attachments")?.textContent).toContain("2 Anhänge");
  bridge.emit("attachments", { files: [] });
  await expect.poll(() => document.querySelector(".composer-attachments")).toBeNull();
});

test("sending clears the old draft forecast and late forecast responses cannot restore it", async () => {
  const bridge = await openWindow();
  const composer = document.querySelector("textarea")!;
  composer.value = "Ein Entwurf";
  composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await expect.poll(() => document.querySelector(".forecast")?.textContent).toBe("~$0.01–0.02");
  let resolve!: (value: unknown) => void;
  bridge.forecasts.push(new Promise((done) => { resolve = done; }));
  composer.value = "Ein neuer Entwurf";
  composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await expect.poll(() => bridge.requests.filter(({ t }) => t === "cost.forecast").length).toBe(2);
  composer.focus();
  await userEvent.keyboard("{Enter}");
  expect(composer.value).toBe("");
  await expect.poll(() => document.querySelector(".forecast")).toBeNull();
  resolve({ kind: "known", text: "~$9.99" });
  await paint();
  expect(document.querySelector(".forecast")).toBeNull();
});

test("streaming Markdown preserves a focused code-copy control and keeps wide code inside the message", async () => {
  const bridge = await openWindow();
  await page.viewport(760, 520);
  const code = "const veryLongIdentifier = " + '"value"'.repeat(70) + ";";
  bridge.emit("assistant", { phase: "begin" });
  bridge.emit("assistant", { phase: "delta", delta: `## Ergebnis\n\n\`\`\`js\n${code}\n\`\`\`\n\nWeiter` });
  await paint();
  const copy = document.querySelector<HTMLButtonElement>(".code-copy")!;
  copy.focus();
  bridge.emit("assistant", { phase: "delta", delta: " mit einer sicheren [Dokumentation](https://example.com/docs)." });
  await paint();
  expect(document.querySelector(".code-copy")).toBe(copy);
  expect(document.activeElement).toBe(copy);
  const pre = document.querySelector<HTMLPreElement>(".message-code pre")!;
  expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
  expect(getComputedStyle(pre).overflowX).toBe("auto");
  expect(document.querySelector(".msg-ai")!.getBoundingClientRect().right).toBeLessThanOrEqual(760);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(760);
});
