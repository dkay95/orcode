/**
 * The window's own drawing, in Desktop v2's card language.
 *
 * Every sentence about the engine's world comes off the wire. The only words
 * this file owns are the names of its own controls, and those are German —
 * the mockup's chrome. Nothing the engine SAYS is translated here: a run's
 * footer, a refusal, a tool's name, a setting's label and a chat row's facts
 * are rendered exactly as they arrived.
 */

import { estimateReasoningTokens } from "@core/utils";
import { composeCrossPanel } from "@core/cross-panel";

import type { Block } from "./chat-model.js";
import { routeCoreBrand } from "./brand.js";
import { headerOf, readApprovalDiff, readDiff, renderDiffView } from "./diff.js";
import { el, replace } from "./dom.js";
import { messageMarkdown } from "./message-markdown.js";
import type { EngineState } from "./engine-state.js";
import { describeExit, describeExitCause, engineHeadline, exitConsequence } from "./engine-state.js";
import type { StatusSegments } from "./hub-model.js";
import type { PendingAsk } from "./asks.js";
import { confirmPresentation, RENDERED_ASK_KINDS } from "./asks.js";

import type {
  ChoiceItem,
  CrossPanel,
  DesktopActiveRoute,
  DesktopCrossPreflightView,
  DesktopSettingsEditorPresentation,
  ToolCallPreview,
} from "./protocol.js";

/* =========================================================================
 * The chat header
 * ====================================================================== */

export interface ChatHeadHandlers {
  /** Opens the canonical shared picker in the context named by Foundation. */
  pickRoute(returnTo: "chat" | "model-picker"): void;
}

export interface ChatHeadRouteState {
  readonly activeRoute: DesktopActiveRoute | null;
  /** Null until the canonical Desktop snapshot arrives. */
  readonly routeRunnable: boolean | null;
}

export function chatHeader(
  title: string,
  segments: StatusSegments | null,
  route: ChatHeadRouteState,
  handlers: ChatHeadHandlers,
  showHeaderMark = false,
): HTMLElement {
  const head = el("header", { class: "chathead" });
  head.append(el("span", { class: "title", text: title }));
  if (route.routeRunnable && route.activeRoute) {
    const account = route.activeRoute.accountLabel ?? route.activeRoute.providerLabel;
    head.append(el("span", {
      class: "chip route-current",
      text: `${route.activeRoute.modelLabel} · ${account}`,
      title: route.activeRoute.providerLabel,
    }));
    const change = el("button", {
      class: "chip route-change",
      type: "button",
      text: "Modell/Konto · Ändern",
    });
    change.addEventListener("click", () => handlers.pickRoute("chat"));
    head.append(change);
  } else if (route.routeRunnable === false) {
    const choose = el("button", {
      class: "chip route-change",
      type: "button",
      text: "Modell wählen",
    });
    choose.addEventListener("click", () => handlers.pickRoute("model-picker"));
    head.append(choose);
  }
  head.append(el("span", { class: "spacer" }));
  if (segments) {
    // The figure is the engine's, through the shared `formatUsd`; only the
    // words beside it are this window's.
    head.append(el("span", { class: "chip" }, [
      el("span", { class: "mono", text: segments.session }),
    ]));
  }
  if (showHeaderMark) head.append(routeCoreBrand("chat-header"));
  return head;
}

/* =========================================================================
 * The status bar
 * ====================================================================== */

export function statusBar(
  segments: StatusSegments | null,
  engineText: string,
  busy: boolean,
): HTMLElement {
  const parts: HTMLElement[] = [];
  if (engineText) {
    parts.push(el("span", { class: busy ? "busy" : "", text: engineText }));
  }
  if (segments) {
    parts.push(el("span", { text: segments.approval }));
    parts.push(el("span", { class: "mono", text: segments.model }));
    parts.push(el("span", { class: "mono", text: segments.folder }));
    if (segments.routeConnected === false) {
      // The engine says there is no runnable route. Said in the status bar
      // rather than as a modal — the owner decides when to connect.
      parts.push(el("span", { class: "warn", text: "kein Anbieter verbunden" }));
    }
  }
  const bar = el("footer", { class: "statusbar" });
  replace(bar, interleave(parts));
  if (segments?.today || segments?.balance) {
    bar.append(el("span", { class: "spacer" }));
    const right: HTMLElement[] = [];
    if (segments.today) right.push(el("span", { class: "mono", text: segments.today }));
    if (segments.balance) {
      right.push(
        el("span", {
          class: segments.balanceLow ? "warn mono" : "mono",
          text: segments.balanceLow
            ? `${segments.balance} — wenig Guthaben`
            : segments.balance,
        }),
      );
    }
    for (const node of interleave(right)) bar.append(node);
  }
  return bar;
}

function interleave(parts: readonly HTMLElement[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(el("span", { class: "sep", text: "·" }));
    out.push(part);
  });
  return out;
}

/* =========================================================================
 * The live Cross panel
 * ====================================================================== */

/**
 * The dashboard's own Cross panel, as a card.
 *
 * Every fact is `dashboardState()`'s, composed by `@core/cross-panel` — the
 * same functions `dashboard-frame.ts` composes its own block with, so the
 * `result`/`phase` dedup and the row grammar cannot drift between the two
 * surfaces. After settling it remains as a clearly labelled last-run/current-
 * selection action surface; those two route pairs are never conflated.
 */
export interface CrossPanelHandlers {
  models(): void;
  swap(): void;
  status(): void;
  stop(): void;
}

type CrossRouteFacts = NonNullable<CrossPanel["lead"]>;

function crossReasoningLabel(reasoning: CrossRouteFacts["reasoning"]): string {
  return ({
    supported: "unterstützt",
    unsupported: "nicht unterstützt",
    unknown: "unbekannt",
  })[reasoning];
}

function crossCapabilityLabel(capability: CrossRouteFacts["capabilities"][number]): string {
  return ({
    text: "Text",
    "image-input": "Bildeingabe",
    tools: "Werkzeuge",
    reasoning: "Denkmodus",
    patch: "Dateiänderungen",
  })[capability];
}

function crossRoutePresentation(candidate: CrossRouteFacts): string {
  return `${candidate.providerLabel} · ${candidate.accountLabel} · ${candidate.displayName} · ${candidate.canonicalModelId}`;
}

function crossRouteDetails(candidate: CrossRouteFacts): string {
  return `Denkmodus: ${crossReasoningLabel(candidate.reasoning)}`
    + ` · Fähigkeiten: ${candidate.capabilities.map(crossCapabilityLabel).join(" · ")}`;
}

export function crossPanel(state: CrossPanel, handlers: CrossPanelHandlers): HTMLElement {
  const composition = composeCrossPanel(state);
  let dispatched = false;
  const controls: HTMLButtonElement[] = [];
  const action = (
    label: string,
    allowed: boolean,
    handler: () => void,
  ): HTMLButtonElement => {
    const control = el("button", {
      class: "chip cross-action",
      type: "button",
      text: label,
      disabled: !allowed,
    });
    control.addEventListener("click", () => {
      if (dispatched || control.disabled) return;
      dispatched = true;
      for (const candidate of controls) candidate.disabled = true;
      handler();
    });
    controls.push(control);
    return control;
  };
  const active = composition.controlsVisible;
  const result = composition.result
    ? el("div", { class: "cross-fact", text: `Result: ${composition.result}` })
    : null;
  const reason = composition.verification.reason
    ? el("div", { class: "cross-fact", text: `Reason: ${composition.verification.reason}` })
    : null;
  const actions = [
    action("Modelle ändern", !active, handlers.models),
    action("Tauschen", !active, handlers.swap),
    action("Status", true, handlers.status),
    ...(active ? [action("Stop", true, handlers.stop)] : []),
  ];
  const role = (label: string, candidate: CrossPanel["lead"]): HTMLElement =>
    el("div", { class: "cross-live-role" }, [
      el("div", {
        class: "cross-fact",
        text: `${label}: ${candidate ? crossRoutePresentation(candidate) : "Nicht verfügbar"}`,
      }),
      candidate
        ? el("div", { class: "cross-fact cross-route-details", text: crossRouteDetails(candidate) })
        : null,
    ]);
  const currentSelection = !active && state.selection
    ? el("div", { class: "cross-current-selection" }, [
        el("div", { class: "cross-fact" }, [el("strong", { text: "Aktuelle Auswahl" })]),
        role("Lead", state.selection.lead),
        role("Challenger", state.selection.challenger),
      ])
    : null;
  return el("div", { class: `cross-panel${composition.verification.reason ? " warn" : ""}` }, [
    el("div", { class: "cross-title" }, [
      el("span", { class: "glyph", text: "●" }),
      el("span", { text: "Cross" }),
    ]),
    role(active ? "Lead" : "Letzter Lauf · Lead", composition.roles[0].value),
    role(active ? "Challenger" : "Letzter Lauf · Challenger", composition.roles[1].value),
    currentSelection,
    el("div", {
      class: "cross-fact",
      text: `${active ? "Phase" : "Phase (letzter Lauf)"}: ${composition.phase}`,
    }),
    result,
    el("div", { class: "cross-fact", text: `Verification: ${composition.verification.status}` }),
    reason,
    el("div", { class: "cross-actions" }, actions),
  ]);
}

/* =========================================================================
 * The stream
 * ====================================================================== */

/** A cheap identity for "this block still looks the same". */
export function blockSignature(block: Block): string {
  switch (block.kind) {
    case "assistant":
      return `${block.text.length}:${block.streaming}`;
    case "reasoning":
      return `${block.text.length}:${block.live}:${block.collapsed}`;
    case "tool":
      return `${block.state}:${block.input}:${block.lines.length}:${block.totalLines}:${block.durationMs ?? ""}:${block.error ?? ""}:${block.collapsed}`;
    case "user":
      return String(block.text.length);
    case "system":
      return `${block.text.length}:${block.footer ?? ""}:${block.level ?? ""}`;
    case "notice":
      return block.text;
    case "command-output":
      return `${block.raw}:${block.lines.length}`;
    case "file-change":
      return `${block.added}:${block.removed}:${block.diff.length}`;
  }
}

export interface StreamHandlers {
  toggle(id: string, collapsed: boolean): void;
  /** The run footer's own control — `/undo`, through the one command path. */
  undo(): void;
}

export function renderBlock(block: Block, handlers: StreamHandlers): HTMLElement {
  switch (block.kind) {
    case "user":
      return el("div", { class: "msg-user", "data-block": block.id }, [
        // An interjection is a turn that landed mid-run. The marker says which
        // it was; the bubble is the same because it is the same person.
        block.interjected ? el("span", { class: "interjected", text: "↳" }) : null,
        document.createTextNode(block.text),
      ]);

    case "assistant":
      return el("div", { class: "msg-ai", "data-block": block.id }, [
        messageMarkdown(block.text),
        block.streaming ? el("span", { class: "cursor", text: "▋" }) : null,
      ]);

    case "reasoning": {
      // P15's shape: the answer leads, the thinking is one click away. The
      // SIZE is the shared estimate (`estimateReasoningTokens`), so the two
      // surfaces cannot claim different sizes for the same thinking.
      const details = el("details", { class: "thinking", "data-block": block.id, open: !block.collapsed });
      // The triangle is drawn by CSS off `details[open]`, so the browser's own
      // toggle keeps it true without a re-render — and the summary keeps the
      // keyboard focus it had.
      const summary = el("summary", { class: "strip" }, [
        el("span", { class: "tri" }),
        el("span", {
          text: block.live
            ? "Denkt …"
            : `Denkprozess · ~${estimateReasoningTokens(block.text)} Tokens`,
        }),
      ]);
      details.append(summary, el("div", { class: "strip-body", text: block.text }));
      details.addEventListener("toggle", () => {
        if (details.isConnected) handlers.toggle(block.id, !details.open);
      });
      return details;
    }

    case "tool": {
      // The badge, the title and the one-line input summary are
      // `toolMetadata`'s — the same three the terminal's tool card shows.
      const meta: (Node | null)[] = [];
      if (block.durationMs !== undefined && block.state !== "running") {
        meta.push(el("span", { class: "mono", text: `${(block.durationMs / 1000).toFixed(1)}s` }));
      }
      if (block.exitCode !== undefined && block.state === "failed") {
        meta.push(el("span", { class: "mono", text: `exit ${block.exitCode}` }));
      }
      // The state's own name, from the shared `ToolBlockState` vocabulary —
      // never a translation, because `unverified` is what the terminal, the
      // run log and the release checklist all call it. `ok` earns no badge:
      // the green dot is the whole claim, and it is not a claim of more.
      if (block.state === "unverified" || block.state === "failed" || block.state === "cancelled") {
        meta.push(el("span", { class: `badge ${block.state}`, text: block.state }));
      }
      if (block.state === "running") meta.push(el("span", { text: "…" }));
      const expandable = block.lines.length > 0 || Boolean(block.error);
      if (expandable) meta.push(el("span", { class: "tri" }));

      const headParts = [
        el("span", { class: "status-dot", "data-state": block.state }),
        el("span", { class: "name", text: block.title }),
        el("span", { class: "path mono", text: block.input }),
        el("span", { class: "meta" }, meta),
      ];
      // A card with nothing folded inside it is not a control: it is drawn as
      // a plain head rather than as something that would do nothing when
      // pressed. A card that HAS something folded inside is a `<details>`, so
      // the browser owns the open state, the keyboard, and the triangle.
      if (!expandable) {
        return el("div", { class: "toolcard", "data-block": block.id }, [
          el("div", { class: "head", "data-static": "true" }, headParts),
        ]);
      }
      const card = el("details", { class: "toolcard", "data-block": block.id, open: !block.collapsed });
      card.append(el("summary", { class: "head" }, headParts));
      if (block.lines.length > 0) {
        card.append(el("div", { class: "lines", text: block.lines.join("\n") }));
        if (block.totalLines > block.lines.length) {
          // What the tail cut, said out loud rather than dropped.
          card.append(
            el("div", {
              class: "diff-note",
              text: `${block.totalLines} Zeilen insgesamt · ${block.lines.length} gezeigt`,
            }),
          );
        }
      } else if (block.error) {
        card.append(el("div", { class: "lines err", text: block.error }));
      }
      card.addEventListener("toggle", () => {
        if (card.isConnected) handlers.toggle(block.id, !card.open);
      });
      return card;
    }

    case "file-change": {
      // The engine's own reader, the terminal's own hunks. The counts on the
      // head line are the FILE's, from the event; the hunks are what fits.
      const card = el("div", { class: "toolcard", "data-block": block.id });
      card.append(
        el("div", { class: "head", "data-static": "true" }, [
          el("span", { class: "status-dot", "data-state": "ok" }),
          el("span", { class: "name", text: block.tool || "Datei" }),
          el("span", { class: "path mono", text: block.path }),
          el("span", { class: "meta" }, [
            // The wire's own word for this state, in the slot the tool-state
            // vocabulary lives in — a German `neu` beside an English
            // `unverified` would blur the chrome/wire line for one label
            // (review i2).
            block.created ? el("span", { class: "badge", text: "created" }) : null,
            el("span", { class: "mono", text: `+${block.added} −${block.removed}` }),
          ]),
        ]),
        renderDiffView(
          readDiff(block.diff, {
            added: block.added,
            removed: block.removed,
            truncated: block.truncated,
          }),
        ),
      );
      return card;
    }

    case "system": {
      if (block.footer !== undefined) {
        // ONE line per run, and every word in it is the engine's. The dot
        // repeats the outcome in colour; the sentence carries it on its own,
        // so colour is never the only carrier.
        const foot = el("div", { class: "runfoot", "data-block": block.id, "data-outcome": block.footer }, [
          el("span", { class: "dot", text: "●" }),
          el("span", { class: "text", text: block.text }),
          el("span", { class: "sep", text: "·" }),
        ]);
        const undo = el("button", { class: "undo", type: "button", text: "Rückgängig" });
        undo.addEventListener("click", () => handlers.undo());
        foot.append(undo);
        return foot;
      }
      return el(
        "div",
        {
          class: "msg-note",
          "data-block": block.id,
          ...(block.level ? { "data-level": block.level } : {}),
        },
        [
          block.meta ? el("span", { class: "meta", text: `${block.meta}:` }) : null,
          document.createTextNode(block.text),
        ],
      );
    }

    case "notice":
      return el("div", { class: "msg-note", "data-block": block.id, "data-level": block.level }, [
        document.createTextNode(block.hint ? `${block.text} — ${block.hint}` : block.text),
      ]);

    case "command-output":
      // The command the owner typed, then what it printed. The `raw` is
      // already on the wire (the engine echoes what it dispatched), so the
      // window never has to remember what it sent.
      return el("div", { class: "toolcard", "data-block": block.id }, [
        el("div", { class: "head", "data-static": "true" }, [
          el("span", { class: "status-dot", "data-state": "ok" }),
          el("span", { class: "path mono", text: block.raw }),
        ]),
        block.lines.length
          ? el("div", { class: "lines", text: block.lines.join("\n") })
          : null,
      ]);
  }
}

/* =========================================================================
 * Dialogs
 * ====================================================================== */

export interface AskHandlers {
  answer(ask: PendingAsk, answer: Record<string, unknown>): void;
  decline(ask: PendingAsk): void;
}

interface Dialog {
  /** Dialog content only; OverlayManager owns the backdrop and ARIA shell. */
  readonly overlay: HTMLElement;
  readonly modal: HTMLElement;
  /** The scrolling middle — a diff, a picker, a long body. */
  readonly body: HTMLElement;
  readonly actions: HTMLElement;
}

function dialog(title: string, options: { warn?: boolean } = {}): Dialog {
  const modal = el("div", {
    class: "modal",
    ...(options.warn ? { "data-overlay-urgency": "assertive" } : {}),
  });
  modal.append(
    el("h2", { class: "mh", "data-overlay-heading": "" }, [
      options.warn ? el("span", { class: "warnic", text: "⚠" }) : null,
      el("span", { text: title }),
    ]),
  );
  const body = el("div", { class: "scroll" });
  const actions = el("div", { class: "actions" });
  modal.append(body, actions);
  return { overlay: modal, modal, body, actions };
}

/**
 * A dialog's control.
 *
 * `primary` fills it with the accent. `isDefault` marks the key default —
 * and D4's rule is that for a danger question those two are never the same
 * button: the accent goes on the accepting choice so its weight is obvious,
 * the default stays on the safe one.
 */
function controlButton(
  label: string,
  options: { primary?: boolean; danger?: boolean; isDefault?: boolean; safe?: boolean } = {},
): HTMLButtonElement {
  const tone = options.danger ? "primary-danger" : options.primary ? "primary" : "ghost";
  return el("button", {
    class: `btn ${tone}`,
    type: "button",
    text: label,
    "data-danger": options.danger === true,
    "data-default": options.isDefault === true,
    "data-overlay-safe-action": options.safe === true,
  });
}

/**
 * The explicit Desktop Cross gate. The engine owns every candidate and
 * action token; this view only arranges those server-minted choices around
 * the secretless preflight projection carried by `event:cross`.
 */
export function crossPreflightPanel(
  preflight: DesktopCrossPreflightView,
  ask: PendingAsk,
  handlers: AskHandlers,
): HTMLElement {
  const { overlay, body, actions } = dialog(String(ask.payload.title ?? "Cross"));
  const items = Array.isArray(ask.payload.items) ? ask.payload.items as ChoiceItem[] : [];
  const buttons: HTMLButtonElement[] = [];
  let answered = false;
  const answer = (value: string): void => {
    if (answered) return;
    answered = true;
    for (const node of buttons) node.disabled = true;
    handlers.answer(ask, { t: "answer", askId: ask.askId, value });
  };
  const actionFor = (
    value: string,
    options: { primary?: boolean; disabled?: boolean } = {},
  ): HTMLButtonElement | null => {
    const item = items.find((candidate) => candidate.value === value);
    if (!item) return null;
    const node = controlButton(item.label, { primary: options.primary });
    node.disabled = options.disabled === true;
    node.addEventListener("click", () => answer(item.value));
    buttons.push(node);
    return node;
  };
  const role = (
    label: "Lead" | "Challenger",
    candidate: DesktopCrossPreflightView["lead"],
    action: "coding" | "review",
  ): HTMLElement => el("div", { class: "cross-preflight-role" }, [
    el("div", { class: "facts" }, [
      el("strong", { text: label === "Lead" ? "Coding-Modell (Lead): " : "Prüfmodell (Challenger): " }),
      document.createTextNode(candidate
        ? crossRoutePresentation(candidate)
        : "Nicht ausgewählt"),
    ]),
    candidate
      ? el("div", {
          class: "facts cross-preflight-route-details",
          text: crossRouteDetails(candidate),
        })
      : null,
    actionFor(action),
  ]);

  body.append(
    el("p", { class: "facts cross-role-explanation", text: "Das Coding-Modell schreibt den Code. Das Prüfmodell kontrolliert ihn. Du wählst beide selbst." }),
    role("Lead", preflight.lead, "coding"),
    role("Challenger", preflight.challenger, "review"),
  );
  const swap = actionFor("swap", { disabled: !(preflight.lead && preflight.challenger) });
  if (swap) body.append(el("div", { class: "actions" }, [swap]));
  body.append(el("div", { class: "facts" }, [
    el("strong", { text: "Aufgabe: " }),
    document.createTextNode(typeof ask.payload.task === "string" && ask.payload.task
      ? ask.payload.task
      : "Nächste Nachricht"),
  ]));

  const duration = el("div", { class: "cross-preflight-duration" }, [
    el("strong", { text: "Dauer" }),
  ]);
  const oneTask = actionFor("duration-one-task");
  const chat = actionFor("duration-chat");
  if (oneTask) {
    const selected = preflight.duration === "one-task";
    oneTask.setAttribute("aria-pressed", String(selected));
    oneTask.classList.toggle("is-selected", selected);
    duration.append(oneTask);
  }
  if (chat) {
    const selected = preflight.duration === "chat";
    chat.setAttribute("aria-pressed", String(selected));
    chat.classList.toggle("is-selected", selected);
    duration.append(chat);
  }
  if (preflight.duration) {
    duration.append(el("span", {
      class: "cross-duration-current",
      text: `Ausgewählt: ${preflight.duration === "one-task" ? "Nur diese Aufgabe" : "Für diesen Chat"}`,
    }));
  }
  body.append(
    duration,
    el("div", {
      class: "facts",
      text: `Auswirkung: ${preflight.estimatedCalls.min}–${preflight.estimatedCalls.max} Modellaufrufe je Aufgabe`,
    }),
    el("div", { class: "facts", text: preflight.cost.label }),
  );
  if (preflight.startDisabled) {
    body.append(el("div", { class: "invalid" }, [
      el("div", { text: preflight.startDisabled.label }),
      preflight.startDisabled.recoveryLabel
        ? el("div", { text: preflight.startDisabled.recoveryLabel })
        : null,
    ]));
  }

  const cancel = controlButton("Abbrechen", { isDefault: true, safe: true });
  cancel.addEventListener("click", () => {
    if (answered) return;
    answered = true;
    for (const node of buttons) node.disabled = true;
    handlers.decline(ask);
  });
  buttons.push(cancel);
  const start = actionFor("start", {
    primary: true,
    disabled: preflight.startDisabled !== null,
  });
  actions.append(cancel);
  if (start) actions.append(start);
  return overlay;
}

function labeledField(
  label: string,
  field: HTMLInputElement | HTMLTextAreaElement,
): HTMLLabelElement {
  return el("label", { class: "overlay-field-label" }, [
    el("span", { text: label }),
    field,
  ]);
}

export function askPanel(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  switch (ask.kind) {
    case "confirm":
      return renderConfirm(ask, handlers);
    case "approval":
      return renderApproval(ask, handlers);
    case "folder-path":
      return renderFolderPath(ask, handlers);
    case "secret":
      return renderSecret(ask, handlers);
    case "choice":
      return renderChoice(ask, handlers);
    case "settings-editor":
      return renderSettingsEditor(ask, handlers);
    case "choose-hub":
      return renderChooseHub(ask, handlers);
    case "choose-model":
      return renderChooseModel(ask, handlers);
    default:
      return renderUnsupported(ask, handlers);
  }
}

function renderConfirm(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  const view = confirmPresentation(ask.payload as never);
  const { overlay, body, actions } = dialog(view.title, { warn: view.danger });
  if (view.consequence) {
    // D4: a danger question prints its consequence on its own line. It is the
    // engine's sentence, unchanged.
    body.append(
      el("div", { class: view.danger ? "conseq" : "mb", text: view.consequence }),
    );
  }
  const accept = controlButton(view.acceptLabel, {
    danger: view.danger,
    primary: !view.danger,
    isDefault: view.defaultControl === "accept",
    safe: view.defaultControl === "accept",
  });
  const decline = controlButton(view.declineLabel, {
    isDefault: view.defaultControl === "decline",
    safe: view.defaultControl === "decline",
  });
  accept.addEventListener("click", () =>
    handlers.answer(ask, { t: "answer", askId: ask.askId, accepted: true }));
  decline.addEventListener("click", () => handlers.decline(ask));
  actions.append(decline, accept);
  return overlay;
}

function renderApproval(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  const preview = (ask.payload.preview ?? {}) as ToolCallPreview;
  const { overlay, body, actions } = dialog(preview.summary || preview.name, { warn: true });
  body.append(
    el("div", { class: "mb" }, [
      el("span", { class: "mono", text: preview.name }),
      document.createTextNode(` · Risiko ${preview.risk}`),
    ]),
  );
  // FIX-3, on the consent point itself: a write approval's `details` IS the
  // unified diff (`changePreview` → `writeApprovalRequest`, `workspace.ts`),
  // read with the engine's own reader and drawn as hunks — never raw text.
  //
  // No consequence strip is invented here: a confirm's consequence is a
  // sentence the ENGINE writes, and an approval ask carries none. Painting a
  // reassuring "this is reversible" line the wire never said would be exactly
  // the fabrication this codebase forbids.
  const diff = readApprovalDiff(preview.details);
  if (diff) {
    const header = headerOf(preview.details ?? "");
    if (header) body.append(el("div", { class: "facts", text: header }));
    body.append(renderDiffView(diff));
  } else if (preview.details) {
    body.append(el("div", { class: "facts", text: preview.details }));
  }
  if (preview.subject) body.append(el("div", { class: "facts", text: preview.subject }));

  const remember = el("input", { type: "checkbox" }) as HTMLInputElement;
  const rememberAvailable =
    ask.payload.rememberAvailable === true && preview.rememberAvailable !== false;
  if (rememberAvailable) {
    body.append(
      el("label", { class: "remember" }, [remember, document.createTextNode("Entscheidung merken")]),
    );
  }

  // `reason` is free text explaining a REJECTION (`approval.ts`): the core
  // folds it into the denial the tool sees, so it rides with the deny and
  // with nothing else.
  const reason = el("input", {
    type: "text",
    class: "field",
    spellcheck: "false",
    autocomplete: "off",
    placeholder: "Warum nicht (optional, das Werkzeug erfährt es)",
  }) as HTMLInputElement;
  const reasonAvailable = ask.payload.reasonAvailable === true;
  if (reasonAvailable) body.append(labeledField("Grund für Ablehnung (optional)", reason));

  // A tool approval is a consent point: the accepting control is never the
  // default, whatever else is on screen. `danger` comes off the wire — the
  // server marks every approval as one — and decides the emphasis only.
  const danger = ask.payload.danger !== false;
  const allow = controlButton("Erlauben", { danger, primary: !danger });
  const deny = controlButton("Ablehnen", { isDefault: true, safe: true });
  allow.addEventListener("click", () =>
    handlers.answer(ask, {
      t: "answer",
      askId: ask.askId,
      accepted: true,
      ...(rememberAvailable && remember.checked ? { remember: "allow" } : {}),
    }),
  );
  deny.addEventListener("click", () =>
    handlers.answer(ask, {
      t: "answer",
      askId: ask.askId,
      accepted: false,
      ...(rememberAvailable && remember.checked ? { remember: "deny" } : {}),
      ...(reasonAvailable && reason.value.trim() ? { reason: reason.value.trim() } : {}),
    }),
  );
  if (rememberAvailable) {
    actions.append(
      el("span", { class: "hint", text: "Die gewählte Entscheidung wird gespeichert" }),
    );
  }
  actions.append(deny, allow);
  return overlay;
}

/**
 * One setting's editor.
 *
 * Foundation decides everything visible: which closed editor a row has, what
 * its German labels and bounds are, and which safe notice may be shown. This
 * dialog collects a decision and hands it back; it never reads Registry
 * identifiers, validates, clamps, or substitutes a default.
 *
 * The allow-all follow-up is a destructive confirm whose description is the
 * warning. It renders in D4's danger grammar — the warning as a consequence
 * strip, and accepting is never the default.
 */
function renderSettingsEditor(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  const editor = ask.payload.editor as DesktopSettingsEditorPresentation;
  if (!editor || typeof editor !== "object") return renderUnsupported(ask, handlers);
  const destructive = editor.kind === "confirm" && editor.destructive === true;
  const { overlay, body, actions } = dialog(editor.title, { warn: destructive });

  if (editor.description) {
    body.append(
      el("div", { class: destructive ? "conseq" : "mb", text: editor.description }),
    );
  }
  if (editor.notice) {
    body.append(el("div", {
      class: "invalid settings-editor-notice",
      "data-level": editor.notice.level,
      text: editor.notice.label,
    }));
  }

  const answer = (decision: import("./protocol.js").DesktopSettingsEditorDecision): void =>
    handlers.answer(ask, {
      t: "answer",
      askId: ask.askId,
      decision,
    });

  const controls: HTMLElement[] = [];

  if (editor.kind === "choice") {
    const choices = el("div", { class: "settings-editor-options" });
    for (const option of editor.options) {
      const choice = pickerRow(option.label, "", option.selected, () =>
        answer({ kind: "choice", optionHandle: option.handle }));
      choice.classList.add("settings-editor-option");
      choices.append(choice);
    }
    body.append(choices);
  } else if (editor.kind === "number" || editor.kind === "text") {
    if (editor.kind === "number") {
      body.append(el("div", { class: "facts", text: editor.constraintLabel }));
    }
    const multiline = editor.kind === "text" && editor.multiline;
    const field: HTMLTextAreaElement | HTMLInputElement = multiline
      ? el("textarea", {
          class: "field",
          rows: "4",
          spellcheck: "false",
          "data-overlay-safe-action": "",
        })
      : el("input", {
          class: "field",
          type: "text",
          spellcheck: "false",
          autocomplete: "off",
          "data-overlay-safe-action": "",
        });
    field.value = editor.initialValue;
    body.append(labeledField(editor.inputLabel, field));
    const save = controlButton(editor.submitLabel, { primary: true, isDefault: true });
    save.addEventListener("click", () => answer({ kind: editor.kind, value: field.value }));
    if (!multiline) {
      field.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") {
          event.preventDefault();
          answer({ kind: editor.kind, value: field.value });
        }
      });
    }
    controls.push(save);
  } else if (editor.kind === "confirm" || editor.kind === "invoke") {
    const accept = controlButton(
      editor.kind === "confirm" ? editor.confirmLabel : editor.invokeLabel,
      {
      danger: destructive,
      primary: !destructive,
      },
    );
    accept.addEventListener("click", () => answer(
      editor.kind === "confirm"
        ? { kind: "confirm", accepted: true }
        : { kind: "invoke" },
    ));
    controls.push(accept);
  }

  const cancel = controlButton(editor.cancelLabel, {
    isDefault: controls.length === 0 || destructive,
    safe: editor.kind !== "number" && editor.kind !== "text",
  });
  cancel.addEventListener("click", () => handlers.decline(ask));
  actions.append(cancel, ...controls);
  return overlay;
}

function renderFolderPath(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  const { overlay, body, actions } = dialog(String(ask.payload.label ?? ""));
  if (typeof ask.payload.description === "string" && ask.payload.description) {
    body.append(el("div", { class: "mb", text: ask.payload.description }));
  }
  const input = el("input", {
    class: "field mono",
    type: "text",
    spellcheck: "false",
    autocomplete: "off",
    "data-overlay-safe-action": "",
  }) as HTMLInputElement;
  body.append(labeledField(String(ask.payload.label ?? "Ordnerpfad"), input));
  const accept = controlButton("Diesen Ordner verwenden", { primary: true, isDefault: true });
  const cancel = controlButton("Abbrechen");
  const submit = (): void => {
    const value = input.value.trim();
    handlers.answer(ask, { t: "answer", askId: ask.askId, path: value ? value : null });
  };
  accept.addEventListener("click", submit);
  cancel.addEventListener("click", () => handlers.decline(ask));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  actions.append(cancel, accept);
  return overlay;
}

function renderSecret(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  const { overlay, body, actions } = dialog(String(ask.payload.label ?? ""));
  // FIX-18's pre-prompt disclosure — the login type, what it costs, what a
  // replacement would displace. Both terminal adapters fold it into this very
  // prompt because it is written to be read before the key is typed; the
  // engine hands it over on the ask for the same reason.
  if (typeof ask.payload.notice === "string" && ask.payload.notice) {
    body.append(el("div", { class: "conseq", text: ask.payload.notice }));
  }
  body.append(
    el("div", {
      class: "mb",
      text: "Dieser Wert geht an den Motor und wird von diesem Fenster nie gespeichert, "
        + "angezeigt oder erneut gelesen.",
    }),
  );
  const input = el("input", {
    class: "field mono",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    "data-overlay-safe-action": "",
  }) as HTMLInputElement;
  body.append(labeledField(String(ask.payload.label ?? "Geheimer Wert"), input));
  const send = controlButton("Senden", { primary: true, isDefault: true });
  // The engine says where Cancel goes when it knows: setup's key stage steps
  // BACK to the provider list, and a control that claimed a full cancel there
  // would be describing something else.
  const cancel = controlButton(
    typeof ask.payload.escHint === "string" && ask.payload.escHint ? "Zurück" : "Abbrechen",
  );
  const submit = (): void => {
    // R-SEC-4, structurally: the value goes from the field into the answer and
    // the field is cleared. It is never put into app state, a log line, or a
    // re-render.
    const value = input.value;
    input.value = "";
    handlers.answer(ask, { t: "answer", askId: ask.askId, value: value ? value : null });
  };
  send.addEventListener("click", submit);
  cancel.addEventListener("click", () => {
    input.value = "";
    handlers.decline(ask);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  actions.append(cancel, send);
  return overlay;
}

/**
 * A choice row's description — as INDIVISIBLE parts when the engine sent
 * parts.
 *
 * FIX-14's ruling, carried onto this surface: the Cross gate's Start row hands
 * over `["4-6 model calls", "est. from $0.07-$0.11", …]`, and the floor marker
 * lives and dies with the figure it qualifies. Each part is rendered whole;
 * nothing may cut INSIDE one, because `est. from $0…` reads as "from $0", i.e.
 * free — the one thing a consent point may never imply.
 */
function describeChoice(item: ChoiceItem & { descriptionParts?: readonly string[] }): HTMLElement {
  const parts = Array.isArray(item.descriptionParts) && item.descriptionParts.length > 0
    ? item.descriptionParts
    : null;
  if (!parts) return el("div", { class: "d", text: item.description ?? "" });
  const node = el("div", { class: "d parts" });
  parts.forEach((part, index) => {
    if (index > 0) node.append(el("span", { class: "part-sep", text: "·" }));
    node.append(el("span", { class: "part", text: part }));
  });
  return node;
}

/**
 * One selectable row in a picker.
 *
 * Extracted rather than repeated: the provider hub, the model chooser and the
 * settings choice editor are the same list with different rows behind it, and
 * a second copy is how two screens start marking "current" differently.
 */
function pickerRow(
  label: string,
  description: string | HTMLElement,
  current: boolean,
  pick: () => void,
): HTMLElement {
  const row = el(
    "button",
    // Stamped only when true: `aria-current="false"` on every other row is
    // valid but noisy for a screen reader (review i4).
    { class: "pickrow", type: "button", ...(current ? { "aria-current": "true" } : {}) },
    [
      el("div", { class: "n" }, [
        el("span", { class: "marker", text: current ? "❯" : "" }),
        el("span", { text: label }),
      ]),
      typeof description === "string"
        ? (description ? el("div", { class: "d", text: description }) : null)
        : description,
    ],
  );
  row.addEventListener("click", pick);
  return row;
}

function renderChoice(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  const { overlay, body, actions } = dialog(String(ask.payload.title ?? ""));
  const items = Array.isArray(ask.payload.items) ? (ask.payload.items as ChoiceItem[]) : [];
  const current = typeof ask.payload.current === "string" ? ask.payload.current : "";
  const picker = el("div", { class: "picker" });
  for (const item of items) {
    picker.append(
      pickerRow(item.label, describeChoice(item), item.value === current, () =>
        // The handle the server minted, never a route: the engine turns the id
        // back into an identity on its own side (F1b).
        handlers.answer(ask, { t: "answer", askId: ask.askId, value: item.value }),
      ),
    );
  }
  body.append(picker);
  const cancel = controlButton("Abbrechen", { isDefault: true, safe: true });
  cancel.addEventListener("click", () => handlers.decline(ask));
  actions.append(cancel);
  return overlay;
}

/**
 * Provider setup, first screen.
 *
 * The rows are `SetupHubEntry`'s own label and description; the marker is the
 * engine's `current`, exactly as `pickChoice` marks the active row in the
 * terminal. The disabled entries — Anthropic / Claude is the only one, and
 * `BackendRegistry` forbids it an adapter — are SHOWN with their reason and
 * are not rows: they carry no handler and no tab stop, so "a disabled row can
 * never be an action" holds structurally rather than by an `if` somebody has
 * to remember.
 */
function renderChooseHub(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  const { overlay, body, actions } = dialog(String(ask.payload.title ?? "Provider setup"));
  const entries = Array.isArray(ask.payload.entries)
    ? (ask.payload.entries as { id: string; label: string; description: string; current?: boolean }[])
    : [];
  const current = typeof ask.payload.current === "string" ? ask.payload.current : "";
  const picker = el("div", { class: "picker" });
  for (const entry of entries) {
    picker.append(
      pickerRow(entry.label, entry.description, entry.id === current || entry.current === true, () =>
        handlers.answer(ask, { t: "answer", askId: ask.askId, id: entry.id }),
      ),
    );
  }
  body.append(picker);
  const unavailable = Array.isArray(ask.payload.unavailable)
    ? (ask.payload.unavailable as { label: string; reason: string }[])
    : [];
  for (const entry of unavailable) {
    body.append(el("div", { class: "unavailable", text: `${entry.label} · ${entry.reason}` }));
  }
  const cancel = controlButton("Abbrechen", { isDefault: true, safe: true });
  cancel.addEventListener("click", () => handlers.decline(ask));
  actions.append(cancel);
  return overlay;
}

/**
 * Provider setup, model screen.
 *
 * `name` is `setupModelRowLabel`'s output — the engine composes it, because
 * the automatic OpenRouter route's row copy ("Automatic routing · OpenRouter
 * picks per request · price dynamic") is a truth about what picking it does,
 * not a formatting choice this window may make. No price is shown for any row
 * for the same reason the terminal shows none: setup's descriptors carry no
 * price, and this codebase never renders a fabricated one.
 */
function renderChooseModel(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  const { overlay, body, actions } = dialog(String(ask.payload.title ?? "Choose a model"));
  const models = Array.isArray(ask.payload.models)
    ? (ask.payload.models as {
        id: string;
        name: string;
        requestedModelId?: string;
        capabilities?: Record<string, boolean>;
      }[])
    : [];
  const picker = el("div", { class: "picker" });
  for (const model of models) {
    const facts = Object.entries(model.capabilities ?? {})
      .filter(([, supported]) => supported === true)
      .map(([capability]) => capability)
      .join(" · ");
    picker.append(
      pickerRow(model.name, facts, false, () =>
        // The canonical id the engine minted the row from. `runSetupHub`
        // matches on exactly this, and answering with anything else is how
        // this screen used to loop on "The selected model route is
        // unavailable."
        handlers.answer(ask, { t: "answer", askId: ask.askId, id: model.id }),
      ),
    );
  }
  body.append(picker);
  const cancel = controlButton("Abbrechen", { isDefault: true, safe: true });
  cancel.addEventListener("click", () => handlers.decline(ask));
  actions.append(cancel);
  return overlay;
}

/**
 * A question this build has no screen for.
 *
 * It is shown, named, and left unanswered until a person says "not now" —
 * never auto-declined and certainly never auto-accepted.
 */
function renderUnsupported(ask: PendingAsk, handlers: AskHandlers): HTMLElement {
  const { overlay, body, actions } = dialog(
    `Der Motor hat eine ${ask.kind}-Frage gestellt.`,
    { warn: true },
  );
  body.append(
    el("div", {
      class: "mb",
      text: `Dieses Fenster hat Dialoge für ${RENDERED_ASK_KINDS.join(", ")}. `
        + "Ablehnen lässt den Zustand des Motors unberührt.",
    }),
  );
  const decline = controlButton("Nicht jetzt", { isDefault: true, safe: true });
  decline.addEventListener("click", () => handlers.decline(ask));
  actions.append(decline);
  return overlay;
}

/* =========================================================================
 * Engine state — the honest dialog when there is no engine
 * ====================================================================== */

export function enginePanel(
  state: EngineState,
  facts: readonly string[],
  runWasActive: boolean,
  onRestart: () => void,
): HTMLElement {
  const failed = state.phase === "stopped" || state.phase === "failed";
  const { overlay, body, actions } = dialog(engineHeadline(state), { warn: failed });
  if (state.phase === "stopped") {
    body.append(el("div", { class: "mb", text: describeExit(state) }));
    // G2 concern 4: the engine's stderr is not protocol and never crosses, so
    // a death before `hello` used to be an exit code and nothing else. The
    // shell now classifies a bounded tail of that stderr into ONE code, and
    // this is that code's sentence — never the engine's own bytes.
    const cause = describeExitCause(state);
    if (cause) body.append(el("div", { class: "mb", text: cause }));
    const consequence = exitConsequence(state, runWasActive);
    if (consequence) body.append(el("div", { class: "conseq", text: consequence }));
  }
  if (state.phase === "failed" && state.failure?.hint) {
    body.append(el("div", { class: "mb", text: state.failure.hint }));
  }
  for (const fact of facts) body.append(el("div", { class: "enginefacts", text: fact }));
  if (failed) {
    const restart = controlButton("Neuen Motor starten", {
      primary: true,
      isDefault: true,
      safe: true,
    });
    restart.addEventListener("click", onRestart);
    actions.append(restart);
  }
  return overlay;
}
