/**
 * One owner for modal mounting, keyboard containment and focus restoration.
 *
 * Renderers return dialog content only. This manager supplies the backdrop
 * and accessibility contract so an ask, the command palette and engine
 * recovery cannot quietly grow different keyboard behaviour.
 */

export interface OverlayRequest {
  readonly id: string;
  readonly trigger: HTMLElement | null;
  readonly labelId: string;
  readonly initialFocus: "safe-action";
  readonly render: () => HTMLElement;
  readonly onDismiss: () => void;
}

export interface OverlayHandle {
  readonly element: HTMLElement;
  close(): void;
}

export type OverlayAnnouncement = "polite" | "assertive";

interface OverlayEntry {
  readonly request: OverlayRequest;
  readonly shell: HTMLElement;
  readonly dialog: HTMLElement;
  readonly restoreFocus: HTMLElement | null;
  closed: boolean;
  dismissing: boolean;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function isVisible(node: HTMLElement): boolean {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function focusableControls(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => {
    if (!isVisible(node)) return false;
    if (node instanceof HTMLInputElement && node.type === "hidden") return false;
    if (node.tabIndex < 0) return false;
    return !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true";
  });
}

function connected(node: HTMLElement | null): node is HTMLElement {
  return node !== null && node.isConnected;
}

export class OverlayManager {
  readonly #app: HTMLElement;
  readonly #host: HTMLElement;
  readonly #status: HTMLElement;
  readonly #alert: HTMLElement;
  readonly #entries: OverlayEntry[] = [];
  readonly #lastAnnouncement: Record<OverlayAnnouncement, string> = {
    polite: "",
    assertive: "",
  };
  #previousInert = false;
  #previousAriaHidden: string | null = null;
  #appSuppressed = false;
  #listening = false;
  #destroyed = false;

  constructor(app: HTMLElement, host: HTMLElement) {
    this.#app = app;
    this.#host = host;
    this.#status = this.#liveRegion("status", "polite");
    this.#alert = this.#liveRegion("alert", "assertive");
    this.#host.append(this.#status, this.#alert);
  }

  open(request: OverlayRequest): OverlayHandle {
    if (this.#destroyed) throw new Error("Cannot open an overlay after its manager was destroyed.");
    if (this.#entries.some((entry) => !entry.closed && entry.request.id === request.id)) {
      throw new Error(`Overlay "${request.id}" is already open.`);
    }

    const restoreFocus = connected(request.trigger) ? request.trigger : activeElement();
    const dialog = request.render();
    const heading = [...dialog.querySelectorAll<HTMLElement>("[id], [data-overlay-heading]")]
      .find((node) => node.id === request.labelId || node.hasAttribute("data-overlay-heading"));
    if (!heading) {
      throw new Error(`Overlay "${request.id}" has no visible heading for ${request.labelId}.`);
    }
    heading.id = request.labelId;
    if (!heading.textContent?.trim() || !isVisible(heading)) {
      throw new Error(`Overlay "${request.id}" must have a visible, non-empty heading.`);
    }

    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", request.labelId);
    const safe = dialog.querySelector<HTMLElement>("[data-overlay-safe-action]");
    if (!safe || !focusableControls(dialog).includes(safe)) {
      throw new Error(`Overlay "${request.id}" must provide a visible enabled safe action.`);
    }

    if (this.#entries.length === 0) {
      this.#previousInert = this.#app.inert === true;
      this.#previousAriaHidden = this.#app.getAttribute("aria-hidden");
      this.#appSuppressed = true;
      this.#app.inert = true;
      this.#app.setAttribute("aria-hidden", "true");
      this.#listen();
    } else {
      const previous = this.#entries.at(-1);
      if (previous) {
        previous.dialog.inert = true;
        previous.shell.setAttribute("aria-hidden", "true");
      }
    }

    const shell = document.createElement("div");
    shell.className = dialog.classList.contains("palette") ? "overlay top" : "overlay";
    shell.dataset.overlayId = request.id;
    shell.append(dialog);
    const entry: OverlayEntry = {
      request,
      shell,
      dialog,
      restoreFocus,
      closed: false,
      dismissing: false,
    };
    this.#entries.push(entry);
    this.#host.append(shell);

    const announcement = heading.textContent.trim();
    const urgency = dialog.dataset.overlayUrgency === "assertive" ? "assertive" : "polite";
    this.announce(announcement, urgency);
    safe.focus();

    return {
      element: shell,
      close: () => this.#close(entry),
    };
  }

  closeTop(): void {
    const top = this.#entries.at(-1);
    if (top) this.#close(top);
  }

  announce(message: string, urgency: OverlayAnnouncement = "polite"): void {
    if (this.#destroyed || this.#lastAnnouncement[urgency] === message) return;
    this.#lastAnnouncement[urgency] = message;
    const region = urgency === "assertive" ? this.#alert : this.#status;
    region.textContent = message;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const entry of this.#entries) {
      entry.closed = true;
      entry.shell.remove();
    }
    this.#entries.length = 0;
    this.#restoreApp();
    this.#unlisten();
    this.#status.remove();
    this.#alert.remove();
  }

  readonly #handleKeydown = (event: KeyboardEvent): void => {
    const top = this.#entries.at(-1);
    if (!top) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (top.dismissing) return;
      top.dismissing = true;
      top.request.onDismiss();
      return;
    }
    if (event.key !== "Tab") return;

    const controls = focusableControls(top.dialog);
    if (controls.length === 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const first = controls[0]!;
    const last = controls.at(-1)!;
    const active = activeElement();
    if (!top.dialog.contains(active)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      event.stopImmediatePropagation();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      event.stopImmediatePropagation();
      first.focus();
    }
  };

  #close(entry: OverlayEntry): void {
    if (entry.closed || this.#destroyed) return;
    const index = this.#entries.indexOf(entry);
    if (index < 0) return;
    entry.closed = true;
    entry.shell.remove();
    this.#entries.splice(index, 1);

    const top = this.#entries.at(-1);
    if (top) {
      top.dialog.inert = false;
      top.shell.removeAttribute("aria-hidden");
      if (index === this.#entries.length) {
        const target = connected(entry.restoreFocus)
          ? entry.restoreFocus
          : top.dialog.querySelector<HTMLElement>("[data-overlay-safe-action]");
        target?.focus();
      }
      return;
    }

    this.#restoreApp();
    this.#unlisten();
    if (connected(entry.restoreFocus)) entry.restoreFocus.focus();
  }

  #restoreApp(): void {
    if (!this.#appSuppressed) return;
    this.#app.inert = this.#previousInert;
    if (this.#previousAriaHidden === null) this.#app.removeAttribute("aria-hidden");
    else this.#app.setAttribute("aria-hidden", this.#previousAriaHidden);
    this.#appSuppressed = false;
  }

  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    document.addEventListener("keydown", this.#handleKeydown);
  }

  #unlisten(): void {
    if (!this.#listening) return;
    this.#listening = false;
    document.removeEventListener("keydown", this.#handleKeydown);
  }

  #liveRegion(role: "status" | "alert", live: OverlayAnnouncement): HTMLElement {
    const node = document.createElement("div");
    node.className = "overlay-live-region";
    node.setAttribute("role", role);
    node.setAttribute("aria-live", live);
    node.setAttribute("aria-atomic", "true");
    return node;
  }
}
