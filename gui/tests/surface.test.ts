import { describe, expect, it, vi } from "vitest";

import { MAX_SETTINGS_BACKS, SessionSurface } from "../src/surface.js";

/**
 * Review M1, as a harness.
 *
 * `engine` is the half of the wire this side cannot decide: it holds whether
 * the ENGINE's Settings session is open, refuses the things `assertSessionIdle`
 * refuses (`src/gui-server.ts:1663`), and answers `back` the way
 * `SettingsController` answers it — a search leaves with another
 * `settings.view`, anything else closes.
 */
function engine(options: { searchDepth?: number; closes?: boolean } = {}) {
  const state = {
    settingsOpen: false,
    searchDepth: options.searchDepth ?? 0,
    /** Everything the engine actually accepted. */
    accepted: [] as string[],
    /** Everything it refused, with the sentence it refused in. */
    refused: [] as string[],
  };
  let surface!: SessionSurface;

  const openSettings = (): void => {
    if (state.settingsOpen) {
      state.refused.push("Settings is already open.");
      return;
    }
    state.settingsOpen = true;
    surface.viewArrived();
  };

  /** `assertSessionIdle`: nothing may start while Settings holds the session. */
  const request = (what: string): void => {
    if (state.settingsOpen) {
      state.refused.push(`Settings is open, so ${what} cannot start.`);
      return;
    }
    state.accepted.push(what);
  };

  const back = (): void => {
    if (state.searchDepth > 0) {
      state.searchDepth -= 1;
      // The controller answers with a level, not a close.
      surface.viewArrived();
      return;
    }
    if (options.closes === false) {
      surface.viewArrived();
      return;
    }
    state.settingsOpen = false;
    surface.closed();
  };

  surface = new SessionSurface({ back });
  return { state, surface, openSettings, request };
}

describe("the surface follows the engine, never a click", () => {
  it("the reviewer's two clicks: Settings open, then the sidebar's Ordner row", () => {
    const { state, surface, openSettings, request } = engine();
    openSettings();
    expect(surface.settingsOpen).toBe(true);

    // The click that used to wedge the window: it flipped the screen to chat
    // BEFORE the request, the engine refused, and nothing left could reach the
    // Settings close.
    surface.run(() => request("/folder"));

    // The controller was asked to hand the session back, it did, and only then
    // did the command go — accepted, not refused.
    expect(state.refused).toEqual([]);
    expect(state.accepted).toEqual(["/folder"]);
    // And the window is where the engine says it is.
    expect(surface.settingsOpen).toBe(false);
    expect(state.settingsOpen).toBe(false);
    expect(surface.waiting).toBe(false);
  });

  it("the ⌘P variant: a palette row takes the same path", () => {
    const { state, surface, openSettings, request } = engine();
    openSettings();
    surface.run(() => request("/undo"));
    expect(state.accepted).toEqual(["/undo"]);
    expect(state.refused).toEqual([]);
    expect(surface.current).toBe("chat");
  });

  it("walks out of a search first, and still lands on the command", () => {
    // `back` from an active search leaves the search and answers with another
    // view; the walk continues rather than giving up or firing early.
    const { state, surface, openSettings, request } = engine({ searchDepth: 1 });
    openSettings();
    surface.run(() => request("/folder"));
    expect(state.accepted).toEqual(["/folder"]);
    expect(surface.settingsOpen).toBe(false);
  });

  it("never leaves the window on a surface the engine disagrees with", () => {
    // The property the wedge violated, stated directly: at every moment the
    // window's surface IS the engine's.
    const { state, surface, openSettings, request } = engine();
    openSettings();
    expect(surface.settingsOpen).toBe(state.settingsOpen);
    surface.run(() => request("/folder"));
    expect(surface.settingsOpen).toBe(state.settingsOpen);
  });

  it("gives up bounded, and leaves Settings visibly open rather than nowhere", () => {
    // A controller that answers every `back` with another view must not turn
    // one click into an endless loop — and when the walk gives up, the owner
    // is left exactly where they can see they are.
    const { state, surface, openSettings, request } = engine({ closes: false });
    openSettings();
    const backs = vi.spyOn(state, "settingsOpen", "get");
    surface.run(() => request("/folder"));
    backs.mockRestore();
    expect(surface.settingsOpen).toBe(true);
    expect(surface.waiting).toBe(false);
    // The action never ran, and it never ran against a refusal either.
    expect(state.accepted).toEqual([]);
    expect(state.refused).toEqual([]);
  });

  it("bounds the walk at MAX_SETTINGS_BACKS", () => {
    let backs = 0;
    const surface = new SessionSurface({ back: () => { backs += 1; surface.viewArrived(); } });
    surface.viewArrived();
    surface.run(() => {});
    expect(backs).toBe(MAX_SETTINGS_BACKS);
  });

  it("runs straight through when Settings was never open", () => {
    const { state, surface, request } = engine();
    surface.run(() => request("/folder"));
    expect(state.accepted).toEqual(["/folder"]);
  });

  it("drops a queued action when the way out is refused", () => {
    // An editor ask is waiting for its answer, so `settings.dispatch` is
    // refused. The action must not stay armed to fire at some unrelated later
    // close.
    const ran = vi.fn();
    const surface = new SessionSurface({ back: () => {} });
    surface.viewArrived();
    surface.run(ran);
    expect(surface.waiting).toBe(true);
    surface.abandon();
    expect(surface.waiting).toBe(false);
    surface.closed();
    expect(ran).not.toHaveBeenCalled();
  });

  it("a new engine carries nothing over", () => {
    const ran = vi.fn();
    const surface = new SessionSurface({ back: () => {} });
    surface.viewArrived();
    surface.run(ran);
    surface.reset();
    expect(surface.current).toBe("chat");
    surface.closed();
    expect(ran).not.toHaveBeenCalled();
  });
});
