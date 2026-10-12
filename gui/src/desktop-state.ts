import type {
  DesktopActivity,
  DesktopCapabilitySnapshot,
  DesktopOnboardingView,
} from "./protocol.js";

export interface DesktopState {
  readonly snapshot: DesktopCapabilitySnapshot | null;
  readonly onboarding: DesktopOnboardingView | null;
  readonly activity: readonly DesktopActivity[];
}

export type DesktopStateInput =
  | { readonly kind: "snapshot"; readonly snapshot: DesktopCapabilitySnapshot }
  | { readonly kind: "onboarding"; readonly view: DesktopOnboardingView }
  | { readonly kind: "activity"; readonly activity: DesktopActivity };

export const INITIAL_DESKTOP_STATE: DesktopState = Object.freeze({
  snapshot: null,
  onboarding: null,
  activity: Object.freeze([]),
});

function compareEpoch(
  left: Pick<DesktopCapabilitySnapshot, "revision" | "generation">,
  right: Pick<DesktopCapabilitySnapshot, "revision" | "generation">,
): number {
  return left.revision === right.revision
    ? left.generation - right.generation
    : left.revision - right.revision;
}

function isCurrentEpoch(
  snapshot: DesktopCapabilitySnapshot,
  value: { readonly revision: number; readonly generation: number },
): boolean {
  return snapshot.revision === value.revision
    && snapshot.generation === value.generation;
}

export function reduceDesktopState(
  state: DesktopState,
  input: DesktopStateInput,
): DesktopState {
  if (input.kind === "snapshot") {
    if (state.snapshot && compareEpoch(input.snapshot, state.snapshot) < 0) return state;

    const advanced = state.snapshot === null
      || compareEpoch(input.snapshot, state.snapshot) > 0;
    return {
      snapshot: input.snapshot,
      onboarding: advanced ? null : state.onboarding,
      activity: advanced ? [] : state.activity,
    };
  }

  const snapshot = state.snapshot;
  if (!snapshot) return state;

  if (input.kind === "onboarding") {
    if (!isCurrentEpoch(snapshot, input.view)) return state;
    if (
      state.onboarding
      && input.view.revision === state.onboarding.revision
      && input.view.generation < state.onboarding.generation
    ) return state;
    return { ...state, onboarding: input.view };
  }

  if (input.activity.revision !== snapshot.revision) return state;
  if (
    input.activity.generation !== undefined
    && input.activity.generation !== snapshot.generation
  ) return state;
  return { ...state, activity: [...state.activity, input.activity] };
}
