import type {
  SettingsController,
  SettingsEditorRequest,
  SettingsEditorResult,
  SettingsIntent,
  SettingsViewModel,
} from "./settings-controller.js";

export interface SettingsSurface {
  begin(
    view: SettingsViewModel,
    control: SettingsSessionControl,
    controller: SettingsController,
  ): Promise<void> | void;
  nextIntent(view: SettingsViewModel): Promise<SettingsIntent>;
  edit(request: SettingsEditorRequest): Promise<SettingsEditorResult>;
  end(): Promise<void> | void;
  /**
   * Optional loading-state hook (Phase 7, E-VIS-02 gap fill): called `true`
   * immediately before `completeEditor` runs and `false` once it settles,
   * so a surface can show an in-progress state while an intent reaches a
   * slow external action (provider activation, a config save under the
   * write lock) — until this, nothing distinguished "still working" from a
   * frozen terminal. Only wraps `completeEditor`, never `dispatch`:
   * `#activate()` (settings-controller.ts) always either resolves
   * synchronously (`{kind:"render"}` — advanced-category expand, a
   * disabled/readonly/non-editable row) or opens an editor
   * (`{kind:"edit"}`) — every row's actual save/external-action work is
   * reached exclusively through `completeEditor`, so wrapping `dispatch`
   * too would only add a busy flash to plain navigation with no slow work
   * behind it to justify one. Surfaces that omit `setBusy` keep today's
   * behavior exactly; `completeEditor` never throws past this pump (every
   * failure already resolves to a notice), so the `finally` below is a
   * belt-and-braces guard, not a load-bearing one.
   */
  setBusy?(active: boolean): void;
}

/**
 * The one out-of-band way an owner closes its current Settings visit.
 *
 * `requestClose()` is idempotent and wakes whichever surface wait currently
 * owns the pump. It is deliberately not a `SettingsIntent`: Desktop already
 * reserves `settings.close` as a request of the session owner, while terminal
 * `back` keeps its existing navigation meaning.
 */
export interface SettingsSessionControl {
  readonly closeRequested: boolean;
  requestClose(): void;
}

/**
 * FIX-14 ticket 12 (FIX-6's parked ruling). A surface that fails while
 * OPENING an editor — `pickModelRoute` reaching a catalog read that throws
 * — rejects straight through this pump, hits the `finally`, and lands the
 * reader back on the dashboard. FIX-6 tried to contain that inside the
 * session and reverted: containment hot-loops whenever the surface replays
 * the same intent, and the pinned test *der Session-Loop beendet auch bei
 * Begin-, Intent-, Editor- und Controllerfehler exakt einmal* deliberately
 * fixes the teardown-and-propagate behaviour.
 *
 * So the teardown stays exactly as pinned. What changes is that the exit is
 * no longer unexplained: the rejection is re-thrown as this error, which
 * names the row whose editor could not open — the fact the reader needs to
 * make sense of Settings vanishing. The original is kept as `cause` and is
 * NOT folded into the message: `settings-controller.ts` already establishes
 * that a foreign failure's own text never reaches this surface (see its
 * "Action could not be completed" notice), and an editor-open failure comes
 * from exactly the same kind of external call.
 */
export class SettingsEditorOpenError extends Error {
  readonly itemId: string;

  constructor(request: Pick<SettingsEditorRequest, "itemId" | "label">, cause: unknown) {
    super(`Settings closed — the editor for "${request.label}" could not be opened.`);
    this.name = "SettingsEditorOpenError";
    this.itemId = request.itemId;
    this.cause = cause;
  }
}

/**
 * One deliberately sequential event pump. At no point can an intent and an
 * editor be outstanding together, and cleanup has one owner: this `finally`.
 */
export async function runSettingsSession(
  controller: SettingsController,
  surface: SettingsSurface,
): Promise<void> {
  let closeRequested = false;
  let resolveClose!: () => void;
  const close = new Promise<void>((resolve) => { resolveClose = resolve; });
  const control: SettingsSessionControl = Object.freeze({
    get closeRequested() { return closeRequested; },
    requestClose() {
      if (closeRequested) return;
      closeRequested = true;
      resolveClose();
    },
  });
  const awaitCloseOr = async <T>(work: Promise<T>): Promise<
    | { readonly kind: "close" }
    | { readonly kind: "value"; readonly value: T }
    | { readonly kind: "error"; readonly error: unknown }
  > => Promise.race([
    work.then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    ),
    close.then(() => ({ kind: "close" as const })),
  ]);

  try {
    await surface.begin(controller.view, control, controller);
    while (true) {
      if (closeRequested) return;
      const next = await awaitCloseOr(Promise.resolve(surface.nextIntent(controller.view)));
      if (next.kind === "close") return;
      if (next.kind === "error") throw next.error;
      const intent = next.value;
      let effect = await controller.dispatch(intent);
      if (closeRequested) {
        if (effect.kind === "edit") {
          await controller.completeEditor(effect.request, { kind: "cancel" });
        }
        return;
      }
      while (effect.kind === "edit") {
        const request = effect.request;
        // FIX-14 ticket 12: same teardown, an honest reason.
        // Invoke the surface through a promise thunk. A GUI adapter may fail
        // synchronously before it can return its promise (for example while
        // constructing a choice); that is still an editor-open failure and
        // must follow the same fixed, cause-hiding classification as an
        // asynchronous rejection.
        const editing = await awaitCloseOr(
          Promise.resolve().then(() => surface.edit(request)),
        );
        if (editing.kind === "close") {
          await controller.completeEditor(request, { kind: "cancel" });
          return;
        }
        if (editing.kind === "error") throw new SettingsEditorOpenError(request, editing.error);
        const result: SettingsEditorResult = editing.value;
        surface.setBusy?.(true);
        try {
          effect = await controller.completeEditor(request, result);
        } finally {
          surface.setBusy?.(false);
        }
        if (closeRequested) {
          if (effect.kind === "edit") {
            await controller.completeEditor(effect.request, { kind: "cancel" });
          }
          return;
        }
      }
      if (effect.kind === "close") return;
    }
  } finally {
    await surface.end();
  }
}
