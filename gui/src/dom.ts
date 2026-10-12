/**
 * Four helpers, and one rule: text goes in through `textContent`, never
 * through `innerHTML`.
 *
 * The engine already strips ANSI, C0/C1 and every bidi override at its
 * outbound boundary (`guardOutboundFrame`), but escaping is this side's own
 * duty (G0 §3.6) and a structural guarantee beats a careful call site. There
 * is no path in this app that parses model output, tool output or a file
 * name as markup.
 */

type Attributes = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: readonly (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Element, children: readonly (Node | null | undefined)[]): void {
  clear(node);
  for (const child of children) if (child) node.append(child);
}
