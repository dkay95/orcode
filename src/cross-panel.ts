/**
 * The live Cross panel's COMPOSITION — one source, for the terminal and the
 * window.
 *
 * The content was already single-source (`CrossCommandRuntime.dashboardState()`
 * projects it once, and the GUI's `cross` event carries that object verbatim).
 * What was written twice, and what the G4 review named as debt, is the SHAPE:
 * which facts appear, in which order, what dedups against what, and when the
 * Control row exists at all. Those are D2 rulings, not layout preferences —
 * `result` deduping against `phase` is the fix for the owner-reported
 * "Cross · Blocked · Blocked" twin, and the Control row naming commands that
 * are only reachable while a run is live is the reason it disappears with it.
 *
 * Import-free by construction, like `settings-rows.ts` and `diff-parse.ts`
 * before it: the WebView's `@core` seam only admits modules nothing
 * Node-shaped can follow. The panel STATE is typed structurally for the same
 * reason — `DashboardState["cross"]` would drag the whole frame's type graph
 * across the seam.
 *
 * The separator is a parameter because the two surfaces genuinely differ
 * there: the terminal draws `theme.glyph("separator")`, which is the owner's
 * own glyph-mode choice, and the window draws its own. Nothing else differs,
 * and nothing else may.
 */

export interface CrossPanelState<Route = string> {
  readonly phase: string;
  readonly reason: string | null;
  readonly verification: string;
  readonly lead: Route;
  readonly challenger: Route;
  readonly active?: boolean;
  readonly result?: string;
}

export interface CrossPanelComposition<Route> {
  readonly phase: string;
  readonly result: string | null;
  readonly roles: readonly [
    Readonly<{ kind: "coding"; value: Route }>,
    Readonly<{ kind: "review"; value: Route }>,
  ];
  readonly verification: Readonly<{ status: string; reason: string | null }>;
  readonly controlsVisible: boolean;
}

/** One semantic Cross composition, before either surface chooses its layout. */
export function composeCrossPanel<Route>(
  state: CrossPanelState<Route>,
): CrossPanelComposition<Route> {
  const roles: CrossPanelComposition<Route>["roles"] = Object.freeze([
    Object.freeze({ kind: "coding" as const, value: state.lead }),
    Object.freeze({ kind: "review" as const, value: state.challenger }),
  ]);
  return Object.freeze({
    phase: state.phase,
    result: state.result && state.result !== state.phase ? state.result : null,
    roles,
    verification: Object.freeze({ status: state.verification, reason: state.reason }),
    controlsVisible: state.active === true,
  });
}

/**
 * `Cross · <phase>[ · <result>]`.
 *
 * D2 (owner design batch, ruling 2): `result` only ever repeats `phase` once a
 * run has concluded — the live coordinator phase settles onto the same
 * terminal label `dashboardState()` already recorded as the last result — so
 * showing both produced "Cross · Blocked · Blocked". One current state, not
 * two labels for it: `result` earns its own segment only when it says
 * something `phase` does not.
 */
export function crossPanelTitle(state: CrossPanelState, separator: string): string {
  const panel = composeCrossPanel(state);
  const settled = panel.result
    ? `${separator}${panel.result}`
    : "";
  return `Cross${separator}${panel.phase}${settled}`;
}

/**
 * The fact rows under the title, in order.
 *
 * Control is last and conditional: it names `/cross status` and `/cross stop`,
 * which are two of the exactly four commands a live Cross run leaves
 * reachable. Offering them once the run has ended would be naming keys that
 * no longer do anything.
 */
export function crossPanelFacts(
  state: CrossPanelState,
  separator: string,
): readonly string[] {
  const panel = composeCrossPanel(state);
  return [
    `Coding${separator}${panel.roles[0].value}`,
    `Review${separator}${panel.roles[1].value}`,
    // The reason rides the verification row rather than a row of its own: it
    // is why verification reads the way it does, and a warn colour is never
    // the only thing carrying it.
    `Verification${separator}${panel.verification.status}${
      panel.verification.reason ? `${separator}${panel.verification.reason}` : ""
    }`,
    ...(panel.controlsVisible
      ? [`Control${separator}/cross status${separator}/cross stop`]
      : []),
  ];
}
