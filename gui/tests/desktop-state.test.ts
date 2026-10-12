import { describe, expect, it } from "vitest";

import {
  INITIAL_DESKTOP_STATE,
  reduceDesktopState,
} from "../src/desktop-state.js";
import type {
  DesktopActivity,
  DesktopCapabilitySnapshot,
  DesktopOnboardingView,
} from "../src/protocol.js";

function snapshot(
  overrides: Partial<DesktopCapabilitySnapshot> = {},
): DesktopCapabilitySnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    generation: 1,
    routeRunnable: false,
    activeRoute: null,
    providers: [],
    undoAvailable: false,
    appearance: { showLargeLogo: true, showHeaderMark: true },
    ...overrides,
  };
}

function onboarding(
  overrides: Partial<DesktopOnboardingView> = {},
): DesktopOnboardingView {
  return {
    revision: 1,
    generation: 1,
    step: "provider",
    returnTo: "chat",
    providers: [],
    candidates: [],
    ...overrides,
  };
}

function activity(
  overrides: Partial<DesktopActivity> = {},
): DesktopActivity {
  return {
    id: "activity-1",
    revision: 1,
    generation: 1,
    kind: "setup",
    level: "info",
    message: { code: "setup-opened", label: "Einrichtung geöffnet" },
    ...overrides,
  };
}

describe("the canonical Desktop reducer", () => {
  it("keeps newest snapshot and onboarding generation only", () => {
    let state = reduceDesktopState(INITIAL_DESKTOP_STATE, {
      kind: "snapshot",
      snapshot: snapshot({ revision: 7, generation: 3 }),
    });
    state = reduceDesktopState(state, {
      kind: "snapshot",
      snapshot: snapshot({ revision: 7, generation: 2 }),
    });
    state = reduceDesktopState(state, {
      kind: "snapshot",
      snapshot: snapshot({ revision: 6, generation: 9 }),
    });
    state = reduceDesktopState(state, {
      kind: "onboarding",
      view: onboarding({ revision: 7, generation: 3 }),
    });
    state = reduceDesktopState(state, {
      kind: "onboarding",
      view: onboarding({ revision: 7, generation: 2 }),
    });

    expect(state.snapshot?.revision).toBe(7);
    expect(state.snapshot?.generation).toBe(3);
    expect(state.onboarding?.generation).toBe(3);
  });

  it("drops activity from an old revision", () => {
    const state = reduceDesktopState(
      reduceDesktopState(INITIAL_DESKTOP_STATE, {
        kind: "snapshot",
        snapshot: snapshot({ revision: 9 }),
      }),
      { kind: "activity", activity: activity({ revision: 8 }) },
    );

    expect(state.activity).toEqual([]);
  });

  it("clears frames made obsolete by a newer snapshot epoch", () => {
    let state = reduceDesktopState(INITIAL_DESKTOP_STATE, {
      kind: "snapshot",
      snapshot: snapshot({ revision: 7, generation: 3 }),
    });
    state = reduceDesktopState(state, {
      kind: "onboarding",
      view: onboarding({ revision: 7, generation: 3 }),
    });
    state = reduceDesktopState(state, {
      kind: "activity",
      activity: activity({ revision: 7, generation: 3 }),
    });
    state = reduceDesktopState(state, {
      kind: "snapshot",
      snapshot: snapshot({ revision: 8, generation: 4 }),
    });

    expect(state.onboarding).toBeNull();
    expect(state.activity).toEqual([]);
  });

  it("accepts activity only for the current revision and generation", () => {
    const current = reduceDesktopState(INITIAL_DESKTOP_STATE, {
      kind: "snapshot",
      snapshot: snapshot({ revision: 9, generation: 4 }),
    });
    const staleGeneration = reduceDesktopState(current, {
      kind: "activity",
      activity: activity({ revision: 9, generation: 3 }),
    });
    const currentGeneration = reduceDesktopState(staleGeneration, {
      kind: "activity",
      activity: activity({ id: "activity-2", revision: 9, generation: 4 }),
    });

    expect(currentGeneration.activity.map(({ id }) => id)).toEqual(["activity-2"]);
  });
});
