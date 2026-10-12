// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { AskQueue, buildAnswer, confirmPresentation, declineAnswer } from "../src/asks.js";
import { PROTOCOL_VERSION, type AskFrame } from "../src/protocol.js";
import { askPanel } from "../src/views.js";

function ask(kind: string, payload: Record<string, unknown> = {}): AskFrame {
  return { t: "ask", v: PROTOCOL_VERSION, askId: `a-${kind}`, kind, ...payload } as AskFrame;
}

describe("D4 — the three confirm states", () => {
  it("a danger question never defaults to accepting", () => {
    const view = confirmPresentation({
      title: "Delete the chat?",
      consequence: "This cannot be undone.",
      danger: true,
      defaultAccept: false,
    });
    expect(view.danger).toBe(true);
    expect(view.defaultControl).toBe("decline");
    expect(view.consequence).toBe("This cannot be undone.");
  });

  it("refuses to reconstruct an accepting default for a danger question", () => {
    // A malformed pair (danger AND defaultAccept) must not produce a
    // one-Enter destructive action.
    const view = confirmPresentation({ title: "x", danger: true, defaultAccept: true });
    expect(view.defaultControl).toBe("decline");
  });

  it("an ordinary question accepts on Enter", () => {
    const view = confirmPresentation({ title: "Continue?", danger: false, defaultAccept: true });
    expect(view.defaultControl).toBe("accept");
    expect(view.danger).toBe(false);
  });

  it("the third state is ordinary in look and danger in keys", () => {
    const view = confirmPresentation({ title: "Spend on this?", danger: false, defaultAccept: false });
    expect(view.danger).toBe(false);
    expect(view.acceptLabel).toBe("Ja");
    expect(view.defaultControl).toBe("decline");
  });
});

describe("answers", () => {
  it("a confirm answers with the decision alone", () => {
    const queue = new AskQueue();
    const pending = queue.push(ask("confirm", { title: "t", danger: false, defaultAccept: true }));
    expect(buildAnswer(pending, { kind: "confirm", accepted: true })).toEqual({
      t: "answer",
      askId: "a-confirm",
      accepted: true,
    });
  });

  it("an approval carries remember only when it was chosen", () => {
    const queue = new AskQueue();
    const pending = queue.push(ask("approval", { preview: { name: "shell" }, danger: true }));
    expect(buildAnswer(pending, { kind: "approval", accepted: true, remember: "allow" })).toEqual({
      t: "answer",
      askId: "a-approval",
      accepted: true,
      remember: "allow",
    });
    expect(buildAnswer(pending, { kind: "approval", accepted: false })).toEqual({
      t: "answer",
      askId: "a-approval",
      accepted: false,
    });
  });

  it("a choice answers with the handle the server minted, never a route", () => {
    const queue = new AskQueue();
    const pending = queue.push(ask("choice", { title: "Model", items: [], current: "" }));
    expect(buildAnswer(pending, { kind: "choice", value: "model-route:2" })).toEqual({
      t: "answer",
      askId: "a-choice",
      value: "model-route:2",
    });
  });

  it("a settings editor answers only with the closed decision bound by askId", () => {
    const queue = new AskQueue();
    const pending = queue.push(ask("settings-editor", { editor: { kind: "invoke" } }));
    expect(buildAnswer(pending, { kind: "settings-editor", decision: { kind: "cancel" } })).toEqual({
      t: "answer",
      askId: "a-settings-editor",
      decision: { kind: "cancel" },
    });
  });
});

describe("secrets", () => {
  it("travel in the answer and nowhere else", () => {
    const queue = new AskQueue();
    const pending = queue.push(ask("secret", { label: "OpenRouter API key" }));
    const answer = buildAnswer(pending, { kind: "secret", value: "sk-or-v1-REALKEY" });
    expect(answer).toEqual({ t: "answer", askId: "a-secret", value: "sk-or-v1-REALKEY" });
    // The value is not in the ask, and answering removes the ask entirely.
    expect(JSON.stringify(pending)).not.toContain("REALKEY");
    queue.resolve(pending.askId);
    expect(JSON.stringify([...(queue.abandonAll() as unknown[])])).not.toContain("REALKEY");
    expect(queue.size).toBe(0);
  });

  it("decline sends a null value, never an empty string that reads as one", () => {
    const queue = new AskQueue();
    const pending = queue.push(ask("secret", { label: "key" }));
    expect(declineAnswer(pending)).toEqual({ t: "answer", askId: "a-secret", value: null });
  });
});

describe("declining", () => {
  it("is the refusal for every kind, and never an acceptance", () => {
    const queue = new AskQueue();
    const declines = ["confirm", "approval", "folder-path", "secret", "choice", "choose-hub", "choose-model", "settings-editor"]
      .map((kind) => declineAnswer(queue.push(ask(kind))));
    for (const answer of declines) {
      expect(answer.accepted === true).toBe(false);
      expect(answer.decision === undefined || answer.decision).not.toEqual({ kind: "confirm", accepted: true });
    }
    expect(declines[0]).toEqual({ t: "answer", askId: "a-confirm", accepted: false });
    expect(declines[1]).toEqual({ t: "answer", askId: "a-approval", accepted: false });
  });
});

describe("the queue", () => {
  it("shows one question at a time, oldest first", () => {
    const queue = new AskQueue();
    queue.push(ask("confirm", { title: "first" }));
    queue.push(ask("folder-path", { label: "second" }));
    expect(queue.current?.kind).toBe("confirm");
    queue.resolve("a-confirm");
    expect(queue.current?.kind).toBe("folder-path");
  });

  it("closes every open question when the engine dies, and answers none", () => {
    const queue = new AskQueue();
    queue.push(ask("approval", { preview: { name: "write_file" } }));
    queue.push(ask("confirm", { title: "t" }));
    const dropped = queue.abandonAll();
    expect(dropped.map((entry) => entry.kind)).toEqual(["approval", "confirm"]);
    expect(queue.current).toBeNull();
  });
});

describe("approval presentation", () => {
  it("uses neutral copy for remembering a decision", () => {
    const queue = new AskQueue();
    const pending = queue.push(ask("approval", {
      preview: { name: "write_file", risk: "write", summary: "Datei schreiben" },
      danger: true,
      rememberAvailable: true,
    }));
    const panel = askPanel(pending, { answer: () => {}, decline: () => {} });

    expect(panel.textContent).toContain("Entscheidung merken");
    expect(panel.textContent).toContain("Die gewählte Entscheidung wird gespeichert");
    expect(panel.textContent).not.toContain("Immer erlauben");
    expect(panel.textContent).not.toMatch(/allow forever|deny forever/i);
  });

  it("gives the optional denial reason a real accessible label", () => {
    const queue = new AskQueue();
    const pending = queue.push(ask("approval", {
      preview: { name: "shell", risk: "execute", summary: "Befehl ausführen" },
      danger: true,
      reasonAvailable: true,
    }));
    const panel = askPanel(pending, { answer: () => {}, decline: () => {} });
    const reason = panel.querySelector<HTMLInputElement>("input[type='text']");

    expect(reason?.labels).toHaveLength(1);
    expect(reason?.labels?.[0]?.textContent?.trim()).toBe("Grund für Ablehnung (optional)");
  });
});

describe("text-entry presentation", () => {
  it("labels number and text settings with the canonical field label", () => {
    for (const [label, kind] of [
      ["Schritte pro Lauf", "number"],
      ["Projektanweisung", "text"],
    ] as const) {
      const queue = new AskQueue();
      const pending = queue.push(ask("settings-editor", { editor: {
        kind,
        title: label,
        description: "Kanonische Beschreibung",
        inputLabel: label,
        initialValue: "",
        ...(kind === "number" ? { constraintLabel: "1 bis 200" } : { multiline: false }),
        submitLabel: "Speichern",
        cancelLabel: "Abbrechen",
        busyLabel: "Änderung wird angewendet …",
      } }));
      const panel = askPanel(pending, { answer: () => {}, decline: () => {} });
      const field = panel.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");

      expect(field?.labels).toHaveLength(1);
      expect(field?.labels?.[0]?.textContent?.trim()).toBe(label);
    }
  });

  it("labels folder and secret fields with the engine's requested value", () => {
    for (const [kind, label] of [
      ["folder-path", "Arbeitsordner"],
      ["secret", "OpenRouter API-Schlüssel"],
    ] as const) {
      const queue = new AskQueue();
      const pending = queue.push(ask(kind, { label }));
      const panel = askPanel(pending, { answer: () => {}, decline: () => {} });
      const field = panel.querySelector<HTMLInputElement>("input");

      expect(field?.labels).toHaveLength(1);
      expect(field?.labels?.[0]?.textContent?.trim()).toBe(label);
    }
  });
});
