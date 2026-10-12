/**
 * Questions the engine is waiting on, and the grammar they are asked in.
 *
 * D4 (`src/approval.ts`, carried onto the wire by `gui-protocol.ts`) has
 * THREE states, and the third is not a rounding of the other two:
 *
 *  | danger | defaultAccept | presentation                      | Enter |
 *  |--------|---------------|-----------------------------------|-------|
 *  | true   | false         | consequence on its own line       | declines |
 *  | false  | true          | ordinary                          | accepts  |
 *  | false  | false         | ordinary — with danger's keys     | declines |
 *
 * The rule that matters more than the table: **a danger confirm's accept
 * control is never the default**. Nothing here may make one, and nothing
 * here may answer a question on a person's behalf — an abandoned approval
 * that resolved `true` would silently authorize a file write.
 */

import type { AskFrame, AskKind, ConfirmAsk, DesktopSettingsEditorDecision } from "./protocol.js";

export interface PendingAsk {
  readonly askId: string;
  readonly kind: AskKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ConfirmPresentation {
  readonly title: string;
  readonly consequence: string | null;
  readonly danger: boolean;
  /** Which control Enter activates. Never `accept` for a danger question. */
  readonly defaultControl: "accept" | "decline";
  readonly acceptLabel: string;
  readonly declineLabel: string;
}

/**
 * The three states, read off the wire rather than re-derived.
 *
 * The labels are the shell's own chrome — a button has to say something, and
 * this window's chrome is German — but every fact in the question (its title,
 * its consequence, whether it is dangerous, what Enter does) comes from the
 * engine and is rendered in the engine's own words.
 */
export function confirmPresentation(payload: Partial<ConfirmAsk>): ConfirmPresentation {
  const danger = payload.danger === true;
  // `defaultAccept` is only ever true for an ordinary question: the server
  // already collapses danger to false (`guiConfirmAskPayload`), and this
  // side refuses to reconstruct a different answer from the same fields.
  const defaultAccept = danger ? false : payload.defaultAccept === true;
  return {
    title: typeof payload.title === "string" ? payload.title : "",
    consequence: typeof payload.consequence === "string" && payload.consequence
      ? payload.consequence
      : null,
    danger,
    defaultControl: defaultAccept ? "accept" : "decline",
    acceptLabel: danger ? "Bestätigen" : "Ja",
    declineLabel: danger ? "Abbrechen" : "Nein",
  };
}

export type AskDecision =
  | { readonly kind: "confirm"; readonly accepted: boolean }
  | {
      readonly kind: "approval";
      readonly accepted: boolean;
      readonly remember?: "allow" | "deny";
      readonly reason?: string;
    }
  | { readonly kind: "folder-path"; readonly path: string | null }
  | { readonly kind: "secret"; readonly value: string | null }
  | { readonly kind: "choice"; readonly value: string | null }
  | { readonly kind: "choose-hub"; readonly id: string | null }
  | { readonly kind: "choose-model"; readonly id: string | null }
  | {
      readonly kind: "settings-editor";
      readonly decision: DesktopSettingsEditorDecision;
    };

/**
 * The answer frame for one decision.
 *
 * R-SEC-4: a secret's value travels client → server inside THIS object and
 * is never written into any state the WebView keeps — no ask record, no log
 * line, no re-render. It exists between the input element and the pipe, and
 * the caller clears the field.
 */
export function buildAnswer(ask: PendingAsk, decision: AskDecision): Record<string, unknown> {
  const base = { t: "answer", askId: ask.askId };
  switch (decision.kind) {
    case "confirm":
      return { ...base, accepted: decision.accepted };
    case "approval":
      return {
        ...base,
        accepted: decision.accepted,
        ...(decision.remember ? { remember: decision.remember } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
    case "folder-path":
      return { ...base, path: decision.path };
    case "secret":
      return { ...base, value: decision.value };
    case "choice":
      return { ...base, value: decision.value };
    case "choose-hub":
    case "choose-model":
      return { ...base, id: decision.id };
    case "settings-editor":
      return {
        ...base,
        decision: decision.decision,
      };
  }
}

/**
 * Declining, per kind — what a person clicking "Not now" means.
 *
 * Every one of these is the refusal the server itself declares as the
 * abandonment fallback, so a decline can never be mistaken for consent.
 */
export function declineAnswer(ask: PendingAsk): Record<string, unknown> {
  switch (ask.kind) {
    case "confirm":
      return buildAnswer(ask, { kind: "confirm", accepted: false });
    case "approval":
      return buildAnswer(ask, { kind: "approval", accepted: false });
    case "folder-path":
      return buildAnswer(ask, { kind: "folder-path", path: null });
    case "secret":
      return buildAnswer(ask, { kind: "secret", value: null });
    case "choice":
      return buildAnswer(ask, { kind: "choice", value: null });
    case "choose-hub":
      return buildAnswer(ask, { kind: "choose-hub", id: null });
    case "choose-model":
      return buildAnswer(ask, { kind: "choose-model", id: null });
    case "settings-editor":
      return buildAnswer(ask, { kind: "settings-editor", decision: { kind: "cancel" } });
  }
}

/** Which kinds this build can put a real screen behind. */
export const RENDERED_ASK_KINDS: readonly AskKind[] = [
  "confirm",
  "approval",
  "folder-path",
  "secret",
  "choice",
  "settings-editor",
  "choose-hub",
  "choose-model",
];

/**
 * The open questions, oldest first.
 *
 * One at a time on screen: the engine serializes them anyway (a request that
 * arrives while a question is open is refused with `question-pending`), and
 * stacking two consent points is how a person answers the wrong one.
 */
export class AskQueue {
  #pending: PendingAsk[] = [];

  get current(): PendingAsk | null {
    return this.#pending[0] ?? null;
  }

  get size(): number {
    return this.#pending.length;
  }

  push(frame: AskFrame): PendingAsk {
    const { t: _t, v: _v, askId, kind, ...payload } = frame as Record<string, unknown> & AskFrame;
    const ask: PendingAsk = {
      askId: String(askId),
      kind: kind as AskKind,
      payload: Object.freeze({ ...payload }),
    };
    this.#pending.push(ask);
    return ask;
  }

  /** Removes an answered question. The answer itself is the caller's to send. */
  resolve(askId: string): PendingAsk | null {
    const index = this.#pending.findIndex((ask) => ask.askId === askId);
    if (index < 0) return null;
    const [ask] = this.#pending.splice(index, 1);
    return ask ?? null;
  }

  /**
   * The engine went away with questions open.
   *
   * They are CLOSED, not answered: there is nobody left to answer to, and an
   * auto-accepted approval would authorize a write against a dead engine's
   * intent. Returns what was dropped so the transcript can say so.
   */
  abandonAll(): readonly PendingAsk[] {
    const dropped = this.#pending;
    this.#pending = [];
    return dropped;
  }
}
