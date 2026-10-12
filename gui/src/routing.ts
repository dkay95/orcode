/**
 * What a composer line IS — the dashboard's own split, as a function.
 *
 * `tui.ts` (≈4106-4165) decides this in one place and this mirrors it
 * exactly:
 *
 *  * while the run owns the line, EVERY line — slash included — goes to the
 *    running task as an interjection (`!runOwnsTheLine && …`);
 *  * otherwise a leading `/` is a COMMAND, never a message;
 *  * anything else is a message.
 *
 * It lives here rather than inline in `main.ts` so the decision is pinnable.
 * It is belt, not braces: the engine refuses a slash `submit` on the wire
 * (`slash-as-message`), because a guarantee about money cannot depend on one
 * client getting an `if` right.
 */
export type ComposerRoute = "interject" | "command" | "submit";

export function routeComposerLine(text: string, runActive: boolean): ComposerRoute {
  if (runActive) return "interject";
  return text.startsWith("/") ? "command" : "submit";
}
