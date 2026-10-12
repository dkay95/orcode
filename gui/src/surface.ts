/**
 * Which surface owns the engine's session — and how an action that needs the
 * other one gets there.
 *
 * This exists because of one defect (review M1). The window used to decide for
 * itself that a click had moved it to the chat screen, *then* ask the engine.
 * When the engine refused — `assertSessionIdle`'s "Settings is open, so a
 * command cannot start. — close Settings first" — the window was on the chat
 * screen while the engine's Settings session was still open, and every path
 * out of that state ran through a control the window had just navigated away
 * from. Two clicks, and only an engine restart recovered.
 *
 * The rule that replaces it: **the surface follows the ENGINE, never a click.**
 *
 *  * `settings.view` means Settings owns the session; `settings.closed` means
 *    it does not. Those two events are the only things that move `current`.
 *  * An action that needs the chat surface does not assume it. It asks the
 *    controller to leave Settings with its own `back` intent and WAITS for
 *    `settings.closed` — so the window and the engine cannot disagree about
 *    which surface holds the session, in either direction.
 *
 * `back` is the controller's own way out and it decides what "back" means:
 * from an active search it leaves the search (and answers with another
 * `settings.view`); otherwise it closes (`{kind:"close"}` →
 * `settings.closed`). So walking out takes at most two steps, and
 * {@link MAX_SETTINGS_BACKS} is the bound that keeps a controller which never
 * closes from turning a click into an endless loop.
 */

export type Surface = "chat" | "settings";

/**
 * How many `back` intents one queued action may spend getting out.
 *
 * Two is the real bound (leave the search, then close). Three leaves a step of
 * slack; past it the action is dropped and Settings simply stays open, which
 * is the honest outcome — the owner is left exactly where they can see they
 * are.
 */
export const MAX_SETTINGS_BACKS = 3;

export interface SurfaceHost {
  /** Dispatches the controller's own `{kind:"back"}` intent. */
  back(): void;
}

export class SessionSurface {
  /** The surface the ENGINE says owns the session. */
  current: Surface = "chat";

  #pending: (() => void) | null = null;
  #backs = 0;
  readonly #host: SurfaceHost;

  constructor(host: SurfaceHost) {
    this.#host = host;
  }

  get settingsOpen(): boolean {
    return this.current === "settings";
  }

  /** True while an action is waiting for Settings to close. */
  get waiting(): boolean {
    return this.#pending !== null;
  }

  /**
   * A `settings.view` arrived: Settings owns the session.
   *
   * If something is waiting to leave, this is the controller answering a
   * `back` with a level rather than a close — so the walk continues, bounded.
   */
  viewArrived(): void {
    this.current = "settings";
    if (!this.#pending) return;
    if (this.#backs >= MAX_SETTINGS_BACKS) {
      this.#drop();
      return;
    }
    this.#backs += 1;
    this.#host.back();
  }

  /** `settings.closed` arrived. Whatever was waiting runs now. */
  closed(): void {
    this.current = "chat";
    this.#backs = 0;
    const run = this.#pending;
    this.#pending = null;
    run?.();
  }

  /**
   * Runs `action` on the chat surface, leaving Settings first if it is open.
   *
   * The action is never run speculatively and the surface is never moved on
   * this side: either Settings is not open and the action runs now, or the
   * controller is asked to close and the action runs when it says it has.
   */
  run(action: () => void): void {
    if (this.current !== "settings") {
      action();
      return;
    }
    this.#pending = action;
    this.#backs = 1;
    this.#host.back();
  }

  /**
   * The way out could not be asked for (the controller refused the intent —
   * an editor is waiting for an answer, say). The action is dropped rather
   * than left armed to fire at some unrelated later close.
   */
  abandon(): void {
    this.#drop();
  }

  /** A new engine: nothing is open here and nothing is queued. */
  reset(): void {
    this.current = "chat";
    this.#drop();
  }

  #drop(): void {
    this.#pending = null;
    this.#backs = 0;
  }
}
