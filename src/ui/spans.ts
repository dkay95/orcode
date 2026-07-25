/**
 * Span model — the only currency between layout and renderer.
 *
 * Rule R1: meaning is set here, never guessed later. A renderer must never
 * look at the *text* of a span to decide how it looks; it looks at `role`.
 */

import { displayWidth } from "./compose.js";

export type Role =
  | "text"
  | "muted"
  | "structure"
  | "accent"
  | "active"
  | "ok"
  | "warn"
  | "danger"
  | "add"
  | "del"
  | "inverse";

export const ROLES: readonly Role[] = Object.freeze([
  "text",
  "muted",
  "structure",
  "accent",
  "active",
  "ok",
  "warn",
  "danger",
  "add",
  "del",
  "inverse",
] as const);

export interface SpanAttributes {
  bold?: boolean;
  underline?: boolean;
}

export interface Span extends SpanAttributes {
  text: string;
  role: Role;
}

export interface Line {
  spans: Span[];
}

export function span(text: string, role: Role = "text", attrs?: SpanAttributes): Span {
  const result: Span = { text, role };
  if (attrs?.bold) result.bold = true;
  if (attrs?.underline) result.underline = true;
  return result;
}

export function line(...spans: Span[]): Line {
  return { spans };
}

/** Plain, ANSI-free text of a line — used by tests, `--stream` and logs. */
export function plainText(value: Line): string {
  let out = "";
  for (const item of value.spans) {
    out += item.text;
  }
  return out;
}

/** Terminal cells the line occupies. */
export function lineWidth(value: Line): number {
  let total = 0;
  for (const item of value.spans) {
    total += displayWidth(item.text);
  }
  return total;
}

export function spansWidth(spans: readonly Span[]): number {
  let total = 0;
  for (const item of spans) {
    total += displayWidth(item.text);
  }
  return total;
}

export function spansText(spans: readonly Span[]): string {
  let out = "";
  for (const item of spans) {
    out += item.text;
  }
  return out;
}
