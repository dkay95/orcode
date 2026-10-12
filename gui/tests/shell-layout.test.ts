// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

import type { BridgeHandlers, EngineInfo } from "../src/bridge.js";
import { mountDesktopWindow, type DesktopWindowBridge } from "../src/main.js";
import type { DesktopCapabilitySnapshot, GuiStatus } from "../src/protocol.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";

const status: GuiStatus = {
  model: "", resolvedModel: "", workspace: "/tmp/orcode-shell", chatId: "new-chat",
  chatTitle: "Neuer Chat", approval: "ask", routeConnected: false, providerManaged: false,
  balanceRemainingUsd: undefined, balanceHedged: true, lowBalanceThresholdUsd: 1,
  dayUsd: undefined, sessionUsd: 0, sessionCostKnowledge: "unknown", runActive: false,
  executionMode: "desktop", ownerPathsAllowed: false,
};

function capabilitySnapshot(overrides: Partial<DesktopCapabilitySnapshot> = {}): DesktopCapabilitySnapshot {
  return {
    schemaVersion: 1, revision: 7, generation: 3, routeRunnable: false, activeRoute: null,
    providers: [], undoAvailable: false,
    appearance: { showLargeLogo: true, showHeaderMark: true },
    ...overrides,
  };
}

class FakeBridge implements DesktopWindowBridge {
  readonly requests: Array<Record<string, unknown>> = [];
  #handlers: BridgeHandlers | null = null;
  constructor(readonly snapshot: DesktopCapabilitySnapshot) {}
  async start(handlers: BridgeHandlers): Promise<EngineInfo> {
    this.#handlers = handlers;
    queueMicrotask(() => handlers.onFrame({
      t: "hello", v: PROTOCOL_VERSION, protocol: PROTOCOL_VERSION,
      orcode: "0.7.0", node: "test", pid: 1, capabilities: [],
    }));
    return { node: "test", script: "fake", workspace: status.workspace, home: "/tmp/home", realHome: false, pid: 1 };
  }
  async request<T = unknown>(t: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ t, ...payload });
    if (t === "status.get") return status as T;
    if (t === "chats.list") return { chats: [] } as T;
    if (t === "desktop.snapshot.get") {
      this.#handlers?.onFrame({ t: "event", v: PROTOCOL_VERSION, e: "desktop.snapshot", snapshot: this.snapshot });
      return { snapshot: this.snapshot } as T;
    }
    return {} as T;
  }
  async write(): Promise<void> {}
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("uses German chrome at the supported minimum", async () => {
  setViewport(760, 520);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeBridge(capabilitySnapshot());
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await vi.waitFor(() => expect(root.querySelector(".newchat")?.textContent).toContain("Neuer Chat"));
    expect(document.documentElement.lang).toBe("de");
    expect(root.textContent).toContain("Letzte Chats");
    expect([...root.querySelectorAll("button .n")].map((label) => label.textContent?.trim()))
      .toEqual(expect.arrayContaining(["Verbinden", "Ordner", "Einstellungen"]));
    expect(root.textContent).not.toContain("Set up a provider");
    expect(root.querySelector(".size-hint")).toBeNull();
  } finally {
    mount.dispose();
  }
});

it("shows a non-mutating hint below 760 by 520", async () => {
  setViewport(759, 519);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const bridge = new FakeBridge(capabilitySnapshot());
  const mount = mountDesktopWindow({ bridge, root });
  try {
    await vi.waitFor(() => expect(root.querySelector(".size-hint")?.textContent).toBe("Fenster vergrößern"));
    await vi.waitFor(() => expect(bridge.requests.some(({ t }) => t === "desktop.snapshot.get")).toBe(true));
    const before = bridge.requests.length;
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(bridge.requests).toHaveLength(before);
  } finally {
    mount.dispose();
  }
});

it("does not retain a subminimum class across dispose and remount", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);

  setViewport(759, 519);
  const first = mountDesktopWindow({ bridge: new FakeBridge(capabilitySnapshot()), root });
  expect(root.classList.contains("shell-too-small")).toBe(true);
  first.dispose();

  setViewport(760, 520);
  const second = mountDesktopWindow({ bridge: new FakeBridge(capabilitySnapshot()), root });
  try {
    expect(root.classList.contains("shell-too-small")).toBe(false);
    expect(root.querySelector(".size-hint")).toBeNull();
  } finally {
    second.dispose();
  }
});
