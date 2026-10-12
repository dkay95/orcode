// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { estimateReasoningTokens } from "@core/utils";

import { AskQueue, type PendingAsk } from "../src/asks.js";
import { ChatModel } from "../src/chat-model.js";
import {
  PROTOCOL_VERSION,
  type AskFrame,
  type DesktopCrossPreflightView,
  type DesktopRouteCandidate,
  type EventFrame,
} from "../src/protocol.js";
import { sidebar } from "../src/sidebar.js";
import {
  askPanel,
  chatHeader,
  crossPanel,
  crossPreflightPanel,
  renderBlock,
  type StreamHandlers,
} from "../src/views.js";

function ask(kind: string, payload: Record<string, unknown> = {}): PendingAsk {
  const queue = new AskQueue();
  return queue.push({ t: "ask", v: PROTOCOL_VERSION, askId: `a-${kind}`, kind, ...payload } as AskFrame);
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!match) throw new Error(`no "${label}" control in: ${root.textContent}`);
  return match as HTMLButtonElement;
}

const noStream: StreamHandlers = { toggle: () => {}, undo: () => {} };

function crossCandidate(
  handle: string,
  displayName: string,
  accountLabel: string,
): DesktopRouteCandidate {
  return {
    handle,
    providerId: "openrouter",
    connectionId: `connection-${handle}`,
    accountLabel,
    canonicalModelId: displayName,
    displayName,
    reasoning: "supported",
    capabilities: ["text", "tools"],
    cost: { kind: "unknown", label: "Kosten unbekannt" },
    dataPolicy: { kind: "unknown", label: "Datenrichtlinie unbekannt" },
    runnable: true,
  };
}

function crossPreflightAsk(): PendingAsk {
  return ask("choice", {
    presentation: "cross-preflight",
    title: "Cross einrichten",
    task: "Parser umbauen",
    items: [
      { value: "coding", label: "Lead auswählen" },
      { value: "review", label: "Challenger auswählen" },
      { value: "swap", label: "Tauschen" },
      { value: "duration-one-task", label: "Nur diese Aufgabe" },
      { value: "duration-chat", label: "Für diesen Chat" },
      { value: "start", label: "Cross starten" },
    ],
  });
}

describe("the Desktop Cross preflight", () => {
  const empty: DesktopCrossPreflightView = {
    lead: null,
    challenger: null,
    duration: null,
    estimatedCalls: { min: 4, max: 6 },
    cost: { kind: "unknown", label: "Kosten unbekannt" },
    startDisabled: {
      code: "cross-selection-incomplete",
      label: "Lead, Challenger und Dauer auswählen",
      recoveryLabel: "Beide Modelle und Dauer wählen",
    },
  };

  it("starts visibly empty and keeps Start structurally disabled", () => {
    const panel = crossPreflightPanel(empty, crossPreflightAsk(), {
      answer: () => {},
      decline: () => {},
    });
    expect(panel.textContent).toContain("Lead");
    expect(panel.textContent).toContain("Challenger");
    expect(panel.textContent).toContain("Nicht ausgewählt");
    expect(panel.textContent).toContain("Parser umbauen");
    expect(panel.textContent).toContain("4–6 Modellaufrufe");
    expect(panel.textContent).toContain("Kosten unbekannt");
    expect(panel.textContent).toContain("Lead, Challenger und Dauer auswählen");
    expect(panel.textContent).toContain("Beide Modelle und Dauer wählen");
    expect(panel.textContent).not.toContain("cross-selection-incomplete");
    expect(button(panel, "Cross starten").disabled).toBe(true);
  });

  it("shows both exact model/account choices and answers one explicit duration choice once", () => {
    const pending = crossPreflightAsk();
    const answer = vi.fn();
    const ready: DesktopCrossPreflightView = {
      ...empty,
      lead: {
        ...crossCandidate("lead", "Shared Model", "Privat"),
        providerLabel: "ChatGPT / Codex",
        canonicalModelId: "openai/gpt-5.4-codex",
      },
      challenger: {
        ...crossCandidate("challenger", "Shared Model", "Privat"),
        providerLabel: "Kimi Code",
        canonicalModelId: "moonshotai/kimi-k3",
      },
      duration: "one-task",
      cost: { kind: "known", label: "Mindestens $0.040–$0.080", source: "provider" },
      startDisabled: null,
    };
    const panel = crossPreflightPanel(ready, pending, { answer, decline: () => {} });
    expect(panel.textContent).toContain("ChatGPT / Codex · Privat · Shared Model · openai/gpt-5.4-codex");
    expect(panel.textContent).toContain("Kimi Code · Privat · Shared Model · moonshotai/kimi-k3");
    expect(panel.textContent).toContain("Denkmodus: unterstützt");
    expect(panel.textContent).toContain("Fähigkeiten: Text · Werkzeuge");
    expect(button(panel, "Nur diese Aufgabe").classList).toContain("is-selected");
    expect(panel.querySelector(".cross-duration-current")?.textContent).toBe("Ausgewählt: Nur diese Aufgabe");
    expect(button(panel, "Für diesen Chat").classList).not.toContain("is-selected");
    expect(button(panel, "Cross starten").disabled).toBe(false);
    button(panel, "Nur diese Aufgabe").click();
    button(panel, "Nur diese Aufgabe").click();
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith(pending, {
      t: "answer",
      askId: pending.askId,
      value: "duration-one-task",
    });
  });
});

describe("an approval", () => {
  it("never makes accepting the default control", () => {
    const panel = askPanel(ask("approval", { preview: { name: "write_file", risk: "write", summary: "Write src/a.ts" }, danger: true, rememberAvailable: true, reasonAvailable: true }), {
      answer: () => {},
      decline: () => {},
    });
    // The attribute marks the default; its ABSENCE is what "never default"
    // looks like in the DOM, and the stylesheet keys off the same fact.
    expect(button(panel, "Erlauben").hasAttribute("data-default")).toBe(false);
    expect(button(panel, "Ablehnen").hasAttribute("data-default")).toBe(true);
    expect(button(panel, "Erlauben").hasAttribute("data-danger")).toBe(true);
  });

  it("gives the accent to the accepting control and the default to the safe one", () => {
    // Desktop v2's dialog grammar, and the one line of it that is a rule
    // rather than a taste: the filled accent button is the CONSEQUENTIAL
    // choice, so its weight is obvious — and it is still never what Enter
    // reaches. If those two ever land on the same button, this fails.
    const panel = askPanel(
      ask("approval", { preview: { name: "write_file", risk: "write", summary: "Write src/a.ts" }, danger: true }),
      { answer: () => {}, decline: () => {} },
    );
    const allow = button(panel, "Erlauben");
    const deny = button(panel, "Ablehnen");
    expect(allow.className).toContain("primary-danger");
    expect(allow.hasAttribute("data-default")).toBe(false);
    expect(deny.className).toContain("ghost");
    expect(deny.getAttribute("data-default")).toBe("");
  });

  it("sends the deny reason the wire offered, and sends it only with a denial", () => {
    const answer = vi.fn();
    const pending = ask("approval", {
      preview: { name: "run_command", risk: "execute", summary: "rm -rf build" },
      danger: true,
      rememberAvailable: false,
      reasonAvailable: true,
    });
    const panel = askPanel(pending, { answer, decline: () => {} });
    const reason = panel.querySelector<HTMLInputElement>("input[type='text']");
    expect(reason, "reasonAvailable must produce a field").not.toBeNull();
    reason!.value = "  that deletes my build  ";

    button(panel, "Ablehnen").click();
    expect(answer).toHaveBeenLastCalledWith(pending, {
      t: "answer",
      askId: pending.askId,
      accepted: false,
      // `reason` is free text explaining a REJECTION (approval.ts).
      reason: "that deletes my build",
    });

    button(panel, "Erlauben").click();
    expect(answer).toHaveBeenLastCalledWith(pending, {
      t: "answer",
      askId: pending.askId,
      accepted: true,
    });
  });

  it("offers no reason field when the wire does not offer one", () => {
    const panel = askPanel(
      ask("approval", { preview: { name: "read_file", risk: "read", summary: "Read a.ts" }, reasonAvailable: false }),
      { answer: () => {}, decline: () => {} },
    );
    expect(panel.querySelector("input[type='text']")).toBeNull();
  });

  it("offers the remember affordance only when the wire says it is available", () => {
    const without = askPanel(
      ask("approval", { preview: { name: "write_file", risk: "write", summary: "Write a.ts" }, rememberAvailable: false }),
      { answer: () => {}, decline: () => {} },
    );
    expect(without.querySelector("input[type='checkbox']")).toBeNull();
    expect(without.textContent).not.toContain("Immer erlauben");

    const with_ = askPanel(
      ask("approval", { preview: { name: "write_file", risk: "write", summary: "Write a.ts" }, rememberAvailable: true }),
      { answer: () => {}, decline: () => {} },
    );
    expect(with_.querySelector("input[type='checkbox']")).not.toBeNull();
    expect(with_.textContent).toContain("Entscheidung merken");
    expect(with_.textContent).not.toContain("Immer erlauben");
  });

  it("invents no consequence the wire never sent", () => {
    // The mockup drew a reassuring "reversible with undo" strip on this
    // dialog. An approval ask carries no consequence sentence, and writing
    // one here would be this window making a claim about what a write can be
    // taken back — exactly what it is not allowed to do.
    const panel = askPanel(
      ask("approval", { preview: { name: "write_file", risk: "write", summary: "Write a.ts" }, danger: true }),
      { answer: () => {}, decline: () => {} },
    );
    expect(panel.querySelector(".conseq")).toBeNull();
  });
});

describe("a danger confirm", () => {
  it("prints its consequence and leaves the default on declining", () => {
    const panel = askPanel(
      ask("confirm", {
        title: "Delete this chat?",
        consequence: "This cannot be undone.",
        danger: true,
        defaultAccept: false,
      }),
      { answer: () => {}, decline: () => {} },
    );
    // The engine's own sentence, on its own strip, unchanged.
    expect(panel.querySelector(".conseq")!.textContent).toBe("This cannot be undone.");
    expect(button(panel, "Bestätigen").hasAttribute("data-default")).toBe(false);
    expect(button(panel, "Abbrechen").hasAttribute("data-default")).toBe(true);
  });

  it("lets an ordinary question default to yes, and only an ordinary one", () => {
    const ordinary = askPanel(
      ask("confirm", { title: "Save it?", danger: false, defaultAccept: true }),
      { answer: () => {}, decline: () => {} },
    );
    expect(button(ordinary, "Ja").getAttribute("data-default")).toBe("");
    expect(button(ordinary, "Nein").hasAttribute("data-default")).toBe(false);
  });
});

describe("a secret", () => {
  it("clears the field on both paths, so the value survives nowhere", () => {
    const answer = vi.fn();
    const decline = vi.fn();
    const pending = ask("secret", { label: "OpenRouter API key" });
    const panel = askPanel(pending, { answer, decline });
    const input = panel.querySelector<HTMLInputElement>("input[type='password']")!;
    input.value = "sk-or-v1-REALKEY";
    button(panel, "Senden").click();
    expect(answer).toHaveBeenCalledWith(pending, {
      t: "answer",
      askId: pending.askId,
      value: "sk-or-v1-REALKEY",
    });
    expect(input.value).toBe("");
    expect(panel.textContent).not.toContain("REALKEY");
  });
});

describe("the setup screens", () => {
  it("shows a disabled provider without ever making it a row", () => {
    const pending = ask("choose-hub", {
      title: "Provider setup",
      current: "openrouter",
      entries: [
        { id: "openrouter", label: "OpenRouter", description: "Pay-as-you-go API key", current: true },
        { id: "kimi-code", label: "Kimi Code", description: "Preview · provider-managed", current: false },
      ],
      unavailable: [
        { id: "anthropic", label: "Anthropic / Claude subscription", reason: "Use Claude Code directly" },
      ],
    });
    const answer = vi.fn();
    const panel = askPanel(pending, { answer, decline: () => {} });
    const rows = [...panel.querySelectorAll<HTMLElement>(".pickrow")];
    expect(rows.map((row) => row.querySelector(".n")?.textContent)).toEqual([
      "❯OpenRouter",
      "Kimi Code",
    ]);
    // Shown, and structurally unpickable: no row, no handler, no tab stop.
    expect(panel.textContent).toContain("Anthropic / Claude subscription · Use Claude Code directly");
    expect(panel.querySelectorAll(".pickrow").length).toBe(2);
    // The engine's `current` is the marker, exactly as `pickChoice` marks it.
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
    // Stamped only on the current row — `aria-current="false"` everywhere else
    // is valid but noisy for a screen reader (review i4).
    expect(rows[1]?.hasAttribute("aria-current")).toBe(false);

    rows[1]?.click();
    expect(answer).toHaveBeenCalledWith(pending, {
      t: "answer",
      askId: pending.askId,
      id: "kimi-code",
    });
  });

  it("answers the model chooser with the CANONICAL id the engine minted", () => {
    const pending = ask("choose-model", {
      title: "Choose a model",
      backendId: "openrouter",
      models: [
        {
          id: "openrouter/auto",
          name: "Automatic routing · OpenRouter picks per request · price dynamic",
          requestedModelId: "openrouter/auto",
          capabilities: { tools: true, textInput: true, textOutput: true, reasoning: false },
        },
      ],
    });
    const answer = vi.fn();
    const panel = askPanel(pending, { answer, decline: () => {} });
    // `setupModelRowLabel`'s copy, composed by the engine and rendered whole.
    expect(panel.textContent).toContain("Automatic routing · OpenRouter picks per request");
    // No price is invented for a route that has none.
    expect(panel.textContent).not.toContain("$");
    panel.querySelector<HTMLElement>(".pickrow")?.click();
    expect(answer).toHaveBeenCalledWith(pending, {
      t: "answer",
      askId: pending.askId,
      id: "openrouter/auto",
    });
  });

  it("folds setup's pre-prompt disclosure into the key prompt itself", () => {
    const panel = askPanel(
      ask("secret", {
        label: "OpenRouter API key",
        notice: "This key is billed to your own OpenRouter account.",
        escHint: "Esc goes back to the provider list",
      }),
      { answer: () => {}, decline: () => {} },
    );
    expect(panel.querySelector(".conseq")!.textContent).toBe(
      "This key is billed to your own OpenRouter account.",
    );
    // The escape hint changes what the control CLAIMS, because setup's key
    // stage steps back to the provider list rather than cancelling.
    expect(button(panel, "Zurück")).toBeTruthy();
  });
});

describe("the sidebar", () => {
  const row = {
    id: "c1",
    title: "Settings-Bug",
    detail: "4 messages · $0.006 · qwen3.8-max · 1h ago",
    workspace: "/w",
    foreign: false,
    age: "1h ago",
    cost: "$0.006",
    model: "qwen3.8-max",
    folder: null as string | null,
  };
  const options = {
    activeChatId: "c1",
    total: 1,
    folder: "~/projekt",
    setupNeeded: false,
    settingsOpen: false,
    ready: true,
  };

  function handlers() {
    return {
      openChat: vi.fn(),
      newChat: vi.fn(),
      run: vi.fn(),
      connect: vi.fn(),
      openSettings: vi.fn(),
    };
  }

  it("shows the current project name with its complete path before a folder change", () => {
    const acted = handlers();
    const workspace = "/Users/owner/Projects/router-code/";
    const side = sidebar([row], acted, { ...options, workspace });
    const project = side.querySelector<HTMLElement>(".project-context")!;
    expect(project.textContent).toContain("router-code");
    expect(project.getAttribute("title")).toBe(workspace);
    expect(project.querySelector(".project-path")?.textContent).toBe(workspace);
    project.querySelector<HTMLButtonElement>("button")!.click();
    expect(acted.run).toHaveBeenCalledWith("/folder");
  });

  it("uses the existing abbreviated folder when no complete workspace is available", () => {
    const side = sidebar([row], handlers(), options);
    const project = side.querySelector<HTMLElement>(".project-context")!;
    expect(project.querySelector(".project-name")?.textContent).toBe("projekt");
    expect(project.getAttribute("title")).toBe("~/projekt");
  });

  it("does not invent a project name when the engine has not supplied a folder", () => {
    const side = sidebar([], handlers(), { ...options, folder: "", ready: false });
    expect(side.querySelector(".project-name")?.textContent).toBe("Kein Projektordner");
    expect(side.querySelector<HTMLButtonElement>(".project-context button")?.disabled).toBe(true);
  });

  it("uses the bundled sidebar brand only when the canonical appearance allows it", () => {
    const side = sidebar([], handlers(), { ...options, showBrand: true });
    expect(side.querySelector(".route-core-brand--sidebar img")?.getAttribute("data-brand"))
      .toBe("route-core");
    expect(sidebar([], handlers(), { ...options, showBrand: false }).querySelector("[data-brand]"))
      .toBeNull();
  });

  it("opens a recent chat through `chat.open`, from the row that names it", () => {
    const acted = handlers();
    const side = sidebar([row], acted, options);
    const item = side.querySelector<HTMLElement>(".chatitem")!;
    expect(item.textContent).toContain("Settings-Bug");
    expect(item.textContent).toContain("1h ago");
    expect(item.textContent).toContain("$0.006");
    expect(item.textContent).toContain("qwen3.8-max");
    item.click();
    expect(acted.openChat).toHaveBeenCalledWith("c1");
  });

  it("says how many chats it is not showing", () => {
    // V4 rule 5: a list that shows fewer rows than it has says so, or it is
    // silently deciding which chats exist.
    const many = sidebar([row], handlers(), { ...options, total: 12 });
    expect(many.textContent).toContain("1 von 12 · ▾");
    expect(sidebar([row], handlers(), options).textContent).not.toContain("▾");
  });

  it("marks the chat the window is showing, and only that one", () => {
    const second = { ...row, id: "c2", title: "Another" };
    const side = sidebar([row, second], handlers(), { ...options, total: 2 });
    const marked = [...side.querySelectorAll(".chatitem")]
      .filter((node) => node.getAttribute("aria-current") === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain("Settings-Bug");
  });

  it("names the folder of a chat that lives somewhere else", () => {
    // Opening it RE-ROOTS the whole runtime, so the row says so beforehand.
    const side = sidebar([{ ...row, foreign: true, folder: "~/Music" }], handlers(), options);
    expect(side.querySelector(".chatitem .folder")!.textContent).toBe("~/Music");
  });

  it("keeps the terminal's own composed row reachable, whole", () => {
    const side = sidebar([row], handlers(), options);
    expect(side.querySelector(".chatitem")!.getAttribute("title")).toContain(row.detail);
  });

  it("starts a new chat and opens Settings from its own footer", () => {
    const acted = handlers();
    const side = sidebar([row], acted, options);
    side.querySelector<HTMLElement>(".newchat")!.click();
    expect(acted.newChat).toHaveBeenCalled();
    const rows = [...side.querySelectorAll<HTMLElement>(".footrow")];
    const names = rows.map((node) => node.textContent);
    expect(names.some((name) => name?.includes("Ordner"))).toBe(true);
    expect(names.some((name) => name?.includes("Einstellungen"))).toBe(true);
    rows.find((node) => node.textContent?.includes("Ordner"))!.click();
    expect(acted.run).toHaveBeenCalledWith("/folder");
    rows.find((node) => node.textContent?.includes("Einstellungen"))!.click();
    expect(acted.openSettings).toHaveBeenCalled();
  });

  it("offers the canonical German connect action only while no route is runnable", () => {
    const acted = handlers();
    const needed = sidebar([row], acted, { ...options, setupNeeded: true });
    const connect = [...needed.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.querySelector(".n")?.textContent === "Verbinden");
    expect(connect).not.toBeUndefined();
    connect?.click();
    expect(acted.connect).toHaveBeenCalledOnce();
    expect(acted.run).not.toHaveBeenCalledWith("/provider setup");
    expect(needed.textContent).not.toContain("Set up a provider");
    expect(sidebar([row], handlers(), options).textContent).not.toContain("Verbinden");
  });

  it("says an empty list is empty rather than showing nothing at all", () => {
    expect(sidebar([], handlers(), options).textContent).toContain("Noch keine Chats.");
  });

  it("disables every row until the engine can answer for it", () => {
    // Before readiness there is nothing on the other end of any of these, and
    // the refusal would land in a stream this screen is not showing. A control
    // that cannot act says so rather than doing nothing.
    const cold = sidebar([row], handlers(), { ...options, ready: false });
    const controls = [...cold.querySelectorAll<HTMLButtonElement>("button")];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((node) => node.disabled)).toBe(true);
    const warm = sidebar([row], handlers(), options);
    expect([...warm.querySelectorAll<HTMLButtonElement>("button")].some((n) => n.disabled))
      .toBe(false);
  });

  it("marks Einstellungen while Settings holds the session, and marks nothing else", () => {
    const open = sidebar([row], handlers(), { ...options, activeChatId: null, settingsOpen: true });
    const marked = [...open.querySelectorAll("[aria-current]")];
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain("Einstellungen");
    // And `aria-current="false"` is never stamped on the rest.
    expect(open.querySelectorAll("[aria-current='false']")).toHaveLength(0);
  });
});

describe("the chat header", () => {
  it("uses one compact Route Core asset only when canonical appearance asks for it", async () => {
    const plain = chatHeader(
      "Neuer Chat",
      null,
      { activeRoute: null, routeRunnable: false },
      { pickRoute: vi.fn() },
      false,
    );
    expect(plain.querySelector('[data-brand="route-core"]')).toBeNull();

    const branded = chatHeader(
      "Chat",
      null,
      { activeRoute: null, routeRunnable: false },
      { pickRoute: vi.fn() },
      true,
    );
    expect(branded.querySelectorAll('img[data-brand="route-core"]')).toHaveLength(1);
    expect(branded.textContent).not.toContain("ORCODE");
  });

  it("uses only the canonical active route and opens the chat picker", () => {
    const pickRoute = vi.fn();
    const head = chatHeader(
      "Chat",
      {
        approval: "ask",
        model: "legacy/status-model-must-not-render",
        chat: "Chat",
        folder: "/tmp",
        today: null,
        session: "mindestens $0.00 dieser Chat",
        balance: null,
        balanceLow: false,
        routeConnected: true,
      },
      {
        activeRoute: {
          routeHandle: "private-route-handle",
          providerLabel: "OpenRouter · Eigentümerkonto",
          modelLabel: "Claude Sonnet 4",
          accountLabel: "Eigentümerkonto",
        },
        routeRunnable: true,
      },
      { pickRoute },
    );

    expect(head.textContent).toContain("Claude Sonnet 4 · Eigentümerkonto");
    expect(head.textContent).not.toContain("legacy/status-model-must-not-render");
    expect(head.textContent).not.toContain("private-route-handle");
    button(head, "Modell/Konto · Ändern").click();
    expect(pickRoute).toHaveBeenCalledExactlyOnceWith("chat");
  });

  it("offers the model-picker return context when no runnable route is active", () => {
    const pickRoute = vi.fn();
    const head = chatHeader(
      "Neuer Chat",
      null,
      { activeRoute: null, routeRunnable: false },
      { pickRoute },
    );

    button(head, "Modell wählen").click();
    expect(pickRoute).toHaveBeenCalledExactlyOnceWith("model-picker");
  });

  it("offers no route action before the canonical snapshot exists", () => {
    const head = chatHeader(
      "Neuer Chat",
      null,
      { activeRoute: null, routeRunnable: null },
      { pickRoute: vi.fn() },
    );

    expect(head.querySelector(".route-change")).toBeNull();
  });
});

describe("the stream after a run has ended", () => {
  /** The same wire order `chat-model.test.ts` replays, rendered. */
  function finishedRun(): HTMLElement {
    const model = new ChatModel();
    const frames = [
      { t: "event", v: PROTOCOL_VERSION, e: "transcript", role: "user", content: "Hi" },
      { t: "event", v: PROTOCOL_VERSION, e: "assistant", phase: "begin", model: "vendor/gui-main" },
      { t: "event", v: PROTOCOL_VERSION, e: "run", event: { type: "run-start", timestamp: 1, model: "vendor/gui-main", maxSteps: 7 } },
      { t: "event", v: PROTOCOL_VERSION, e: "run", event: { type: "reasoning", timestamp: 1, delta: "Weighing the options." } },
      { t: "event", v: PROTOCOL_VERSION, e: "assistant", phase: "delta", delta: "Hello world." },
      { t: "event", v: PROTOCOL_VERSION, e: "run", event: { type: "run-end", timestamp: 1, outcome: "complete", durationMs: 9, toolCount: 0 } },
      { t: "event", v: PROTOCOL_VERSION, e: "assistant", phase: "end", text: "Hello world." },
      { t: "event", v: PROTOCOL_VERSION, e: "transcript", role: "system", content: "Run complete · $0.00200 · vendor/gui-main" },
    ] as EventFrame[];
    for (const frame of frames) model.apply(frame);
    const root = document.createElement("div");
    for (const block of model.blocks) root.append(renderBlock(block, noStream));
    return root;
  }

  it("paints no caret anywhere — the run is over", () => {
    // The caret is the window's own live-stream glyph. On a settled block it
    // is the box artifact the owner photographed, not a cursor.
    expect(finishedRun().querySelectorAll(".cursor")).toHaveLength(0);
  });

  it("says the answer once", () => {
    const text = finishedRun().textContent ?? "";
    expect(text.split("Hello world.").length - 1).toBe(1);
  });

  it("draws exactly ONE run footer, in the engine's own words", () => {
    const root = finishedRun();
    const feet = root.querySelectorAll(".runfoot");
    expect(feet).toHaveLength(1);
    // The sentence is the engine's `runFooter`, whole and unedited — the
    // window adds a dot and its own undo control, and not one fact.
    expect(feet[0]!.querySelector(".text")!.textContent).toBe(
      "Run complete · $0.00200 · vendor/gui-main",
    );
    expect(feet[0]!.getAttribute("data-outcome")).toBe("complete");
    expect(root.textContent).not.toContain("tool call(s)");
  });

  it("wires the footer's Rückgängig to the engine's own /undo", () => {
    const undo = vi.fn();
    const model = new ChatModel();
    const frames = [
      { t: "event", v: PROTOCOL_VERSION, e: "run", event: { type: "run-start", timestamp: 1, model: "m", maxSteps: 7 } },
      { t: "event", v: PROTOCOL_VERSION, e: "run", event: { type: "run-end", timestamp: 1, outcome: "complete" } },
      { t: "event", v: PROTOCOL_VERSION, e: "transcript", role: "system", content: "Run complete · $0.001 · m" },
    ] as EventFrame[];
    for (const frame of frames) model.apply(frame);
    const footer = model.blocks.find((block) => block.kind === "system")!;
    const node = renderBlock(footer, { toggle: () => {}, undo });
    const control = [...node.querySelectorAll("button")].find(
      (b) => b.textContent === "Rückgängig",
    )!;
    control.click();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("closes the thinking into a strip that keeps the shared token estimate", () => {
    const details = finishedRun().querySelector<HTMLDetailsElement>(".thinking");
    expect(details, "the thinking must still be reachable").not.toBeNull();
    // P15: collapsed by default, one click from the whole thought.
    expect(details!.open).toBe(false);
    // The SIZE is the shared estimate, so the two surfaces cannot claim
    // different sizes for the same thinking; only the label is this window's.
    const tokens = estimateReasoningTokens("Weighing the options.");
    expect(details!.querySelector("summary")?.textContent).toBe(
      `Denkprozess · ~${tokens} Tokens`,
    );
  });
});

describe("a tool card", () => {
  function toolRun(overrides: Record<string, unknown>): HTMLElement {
    const model = new ChatModel();
    const frames = [
      { t: "event", v: PROTOCOL_VERSION, e: "run", event: { type: "run-start", timestamp: 1, model: "m", maxSteps: 7 } },
      { t: "event", v: PROTOCOL_VERSION, e: "run", event: { type: "tool-start", timestamp: 1, id: "t1", number: 1, name: "write_file", input: { path: "src/a.ts" } } },
      { t: "event", v: PROTOCOL_VERSION, e: "run", event: { type: "tool-end", timestamp: 1, id: "t1", durationMs: 1200, ...overrides } },
    ] as EventFrame[];
    for (const frame of frames) model.apply(frame);
    const block = model.blocks.find((entry) => entry.kind === "tool")!;
    return renderBlock(block, noStream);
  }

  it("badges an unverified tool, and says so in the word the run log uses", () => {
    // No exit code means UNVERIFIED — the shared `classifyToolOutcome`'s
    // grading, and the badge is that state's own name, never a translation.
    const card = toolRun({ output: { stdout: "written" } });
    expect(card.querySelector(".status-dot")!.getAttribute("data-state")).toBe("unverified");
    expect(card.querySelector(".badge.unverified")!.textContent).toBe("unverified");
  });

  it("gives a finished tool a green dot and no badge claiming more", () => {
    const card = toolRun({ output: { stdout: "ok", exitCode: 0 } });
    expect(card.querySelector(".status-dot")!.getAttribute("data-state")).toBe("ok");
    expect(card.querySelector(".badge")).toBeNull();
  });

  it("marks a failure in colour AND in words, with the exit code beside it", () => {
    const card = toolRun({ output: { stdout: "", stderr: "boom", exitCode: 2 } });
    expect(card.querySelector(".status-dot")!.getAttribute("data-state")).toBe("failed");
    expect(card.querySelector(".badge.failed")!.textContent).toBe("failed");
    expect(card.textContent).toContain("exit 2");
  });
});

describe("the live Cross panel", () => {
  const lead = {
    providerLabel: "OpenAI",
    accountLabel: "Codex Privat",
    displayName: "Shared Model",
    canonicalModelId: "openai/gpt-5.4-codex",
    reasoning: "supported" as const,
    capabilities: ["text", "tools", "reasoning"] as const,
  };
  const challenger = {
    providerLabel: "OpenRouter",
    accountLabel: "OpenRouter Privat",
    displayName: "Shared Model",
    canonicalModelId: "moonshotai/kimi-k3",
    reasoning: "unknown" as const,
    capabilities: ["text", "tools"] as const,
  };
  const base = {
    sequence: 4,
    updatedAt: 1,
    phase: "Implementing",
    reason: null as string | null,
    verification: "Not run",
    lead,
    challenger,
    selection: { lead: challenger, challenger: lead },
    active: true,
  };

  const handlers = () => ({
    models: vi.fn(),
    swap: vi.fn(),
    status: vi.fn(),
    stop: vi.fn(),
  });

  it("shows both exact roles, the current phase, and visible Stop in one active panel", () => {
    const controls = handlers();
    const live = crossPanel(base, controls);
    expect(live.textContent).toContain("Lead: OpenAI · Codex Privat · Shared Model · openai/gpt-5.4-codex");
    expect(live.textContent).toContain("Denkmodus: unterstützt · Fähigkeiten: Text · Werkzeuge · Denkmodus");
    expect(live.textContent).toContain("Challenger: OpenRouter · OpenRouter Privat · Shared Model · moonshotai/kimi-k3");
    expect(live.textContent).toContain("Denkmodus: unbekannt · Fähigkeiten: Text · Werkzeuge");
    expect(live.textContent).toContain("Phase: Implementing");
    expect(live.textContent).toContain("Verification: Not run");
    expect(button(live, "Modelle ändern").disabled).toBe(true);
    expect(button(live, "Tauschen").disabled).toBe(true);
    expect(button(live, "Status").disabled).toBe(false);
    expect(button(live, "Stop").disabled).toBe(false);

    const settled = crossPanel({ ...base, active: false }, handlers());
    expect(settled.textContent).toContain("Letzter Lauf · Lead: OpenAI · Codex Privat · Shared Model · openai/gpt-5.4-codex");
    expect(settled.textContent).toContain("Aktuelle Auswahl");
    expect(settled.textContent).toContain("Lead: OpenRouter · OpenRouter Privat · Shared Model · moonshotai/kimi-k3");
    expect(settled.textContent).toContain("Phase (letzter Lauf): Implementing");
    expect([...settled.querySelectorAll("button")].map((node) => node.textContent)).not.toContain("Stop");
    expect(button(settled, "Modelle ändern").disabled).toBe(false);
    expect(button(settled, "Tauschen").disabled).toBe(false);
  });

  it("dispatches every approved direct action exactly once and locks until a new panel", () => {
    for (const [label, key] of [
      ["Modelle ändern", "models"],
      ["Tauschen", "swap"],
      ["Status", "status"],
    ] as const) {
      const controls = handlers();
      const panel = crossPanel({ ...base, active: false }, controls);
      button(panel, label).click();
      button(panel, label).click();
      expect(controls[key]).toHaveBeenCalledTimes(1);
      expect([...panel.querySelectorAll("button")].every((node) => (node as HTMLButtonElement).disabled)).toBe(true);

      // A fresh server snapshot rebuilds the panel and enables its valid actions.
      expect(button(crossPanel({ ...base, active: false }, controls), label).disabled).toBe(false);
    }

    const liveControls = handlers();
    const live = crossPanel(base, liveControls);
    button(live, "Stop").click();
    button(live, "Stop").click();
    expect(liveControls.stop).toHaveBeenCalledTimes(1);
    expect([...live.querySelectorAll("button")].every((node) => (node as HTMLButtonElement).disabled)).toBe(true);
  });

  it("keeps a reason and a distinct result in words", () => {
    const twin = crossPanel({ ...base, phase: "Blocked", result: "Blocked", active: false }, handlers());
    expect(twin.textContent).toContain("Phase (letzter Lauf): Blocked");
    expect(twin.textContent).not.toContain("Result: Blocked");
    const differing = crossPanel({ ...base, phase: "Ready", result: "Partial", active: false }, handlers());
    expect(differing.textContent).toContain("Result: Partial");

    const blocked = crossPanel({ ...base, reason: "Verification failed", active: false }, handlers());
    expect(blocked.textContent).toContain("Reason: Verification failed");
    // Colour is never the only carrier — the reason is in the text, and the
    // warn class is an addition to it, not a substitute for it.
    expect(blocked.className).toContain("warn");
  });
});
