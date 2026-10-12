/**
 * Who owns the real terminal right now (FIX-19, findings 3 + addendum).
 *
 * Two surfaces in this codebase read raw stdin: the fullscreen `TerminalUi`
 * (alternate screen, its own keypress decoder, a composer buffer) and the
 * plain in-place list picker (`list-plain.ts`, used by `/model`'s legacy
 * catalog path, `/chats`, the Cross gate and the resume prompt). Nothing
 * stopped them from being live at the same time, and when a command opened a
 * plain picker while the fullscreen UI was still attached, BOTH read every
 * byte:
 *
 *   - the picker's own frame was overwritten by the next TUI render, so its
 *     Escape looked dead — the picker was in fact still there, invisible;
 *   - every character typed as a picker filter was ALSO typed into the
 *     fullscreen composer, and a later Enter submitted that polluted draft
 *     as a real prompt — an unrequested, paid run.
 *
 * The fix is ownership, not a second layer of key routing: whoever owns the
 * terminal registers a suspender here, and the plain picker runs inside it.
 * `TerminalUi.suspend` already does exactly the right thing (detach the
 * keypress listeners, leave the alternate screen, restore and repaint
 * afterwards) — this module is only the seam that lets a module which must
 * not import `tui.ts` reach it.
 *
 * Registration is process-wide because the terminal is. A surface that never
 * registers (tests driving a fake `PlainListIo`, the plain REPL loop, a
 * non-interactive run) leaves this empty, and `withTerminalHandover` is then
 * a transparent pass-through — exactly the behaviour every existing caller
 * already had.
 */

export type TerminalHandover = <T>(operation: () => Promise<T>) => Promise<T>;

let owner: TerminalHandover | null = null;

/**
 * Claims the terminal for a fullscreen surface, or releases it with `null`.
 * Idempotent, and deliberately last-writer-wins: only one fullscreen surface
 * is ever attached at a time, and a release that arrives after a re-claim
 * (`suspend`'s own `start()` in its `finally`) would otherwise leave the
 * seam empty while the UI is very much attached — so a release only clears
 * the handover it was given.
 */
export function holdTerminal(handover: TerminalHandover | null): void {
  owner = handover;
}

/** Releases `handover`, but only if it is still the registered owner. */
export function releaseTerminal(handover: TerminalHandover): void {
  if (owner === handover) owner = null;
}

/**
 * Runs `operation` with sole ownership of the terminal: under the registered
 * fullscreen surface's suspend/restore if there is one, directly otherwise.
 */
export function withTerminalHandover<T>(operation: () => Promise<T>): Promise<T> {
  const handover = owner;
  return handover ? handover(operation) : operation();
}

/** True while a fullscreen surface owns the terminal. Read by honesty checks, never to route keys. */
export function terminalHeld(): boolean {
  return owner !== null;
}
