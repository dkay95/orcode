/**
 * A deliberately small Markdown presentation, built only from DOM nodes.
 * Raw HTML, images and unknown syntax stay text; nothing executes or loads
 * remotely. This is not a second document engine or a CommonMark parser.
 */
import { el } from "./dom.js";

function safeHref(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function inline(text: string, depth = 0): Node[] {
  if (depth >= 5) return [document.createTextNode(text)];
  const nodes: Node[] = [];
  // Each match consumes input, and recursive emphasis is depth-bounded.
  const token = /(`+)([^`\n]*?)\1|(!?)\[([^\]\n]+)\]\(([^\s)]*)\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let end = 0;
  for (const match of text.matchAll(token)) {
    if (match.index > end) nodes.push(document.createTextNode(text.slice(end, match.index)));
    if (match[1]) nodes.push(el("code", { text: match[2] }));
    else if (match[4] !== undefined) {
      const href = match[3] ? null : safeHref(match[5]);
      nodes.push(href
        ? el("a", { href, target: "_blank", rel: "noopener noreferrer", text: match[4] })
        : document.createTextNode(match[0]));
    } else {
      const strong = match[6] ?? match[7];
      nodes.push(el(strong !== undefined ? "strong" : "em", {}, inline(strong ?? match[8] ?? match[9], depth + 1)));
    }
    end = match.index + match[0].length;
  }
  if (end < text.length) nodes.push(document.createTextNode(text.slice(end)));
  return nodes;
}

function codeBlock(text: string, language: string): HTMLElement {
  const code = el("code", { text });
  const copy = el("button", { class: "code-copy", type: "button", text: "Code kopieren" });
  const status = el("span", { class: "code-copy-status", role: "status" });
  copy.addEventListener("click", async () => {
    copy.disabled = true;
    status.textContent = "";
    try {
      // A failed/missing clipboard API never earns a success label.
      await navigator.clipboard.writeText(code.textContent ?? "");
      copy.textContent = "Kopiert";
      status.textContent = "Code kopiert.";
    } catch {
      copy.textContent = "Code kopieren";
      status.textContent = "Kopieren nicht möglich. Code bitte markieren und kopieren.";
    } finally {
      copy.disabled = false;
    }
  });
  return el("div", { class: "message-code" }, [
    el("div", { class: "message-code-head" }, [
      el("span", { class: "code-language", text: language || "Code" }), copy,
    ]),
    el("pre", { tabindex: "0", "aria-label": language ? `Code: ${language}` : "Code" }, [code]),
    status,
  ]);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+)$/;
const LIST = /^\s*(?:([-+*])\s+|(\d+)[.)]\s+)(.+)$/;
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || LIST.test(line) || /^\s*>/.test(line);
}

export function messageMarkdown(text: string): HTMLElement {
  const root = el("div", { class: "message-markdown" });
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      const code: string[] = [];
      index += 1;
      const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      root.append(codeBlock(code.join("\n"), fence[2].trim()));
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      root.append(el(`h${heading[1].length}` as "h1", {}, inline(heading[2].replace(/\s+#+\s*$/, ""))));
      index += 1;
      continue;
    }
    const item = line.match(LIST);
    if (item) {
      const ordered = item[2] !== undefined;
      const list = el(ordered ? "ol" : "ul", ordered ? { start: item[2] } : {});
      while (index < lines.length) {
        const next = lines[index].match(LIST);
        if (!next || (next[2] !== undefined) !== ordered) break;
        list.append(el("li", {}, inline(next[3])));
        index += 1;
      }
      root.append(list);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*> ?/, ""));
      root.append(el("blockquote", {}, inline(quote.join("\n"))));
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) paragraph.push(lines[index++]);
    root.append(el("p", {}, inline(paragraph.join("\n"))));
  }
  return root;
}

/** Keep settled code controls and focused links mounted as text streams. */
export function updateMessageMarkdown(current: HTMLElement, next: HTMLElement): void {
  const previous = [...current.children];
  const incoming = [...next.children];
  incoming.forEach((node, index) => {
    const before = previous[index];
    if (before?.classList.contains("message-code") && node.classList.contains("message-code")) {
      const code = before.querySelector("pre code")!;
      const content = node.querySelector("pre code")!.textContent;
      if (code.textContent !== content) {
        code.textContent = content;
        before.querySelector(".code-copy")!.textContent = "Code kopieren";
        before.querySelector(".code-copy-status")!.textContent = "";
      }
      before.querySelector(".code-language")!.textContent = node.querySelector(".code-language")!.textContent;
      return;
    }
    if (before?.isEqualNode(node)) return;
    if (before) before.replaceWith(node);
    else current.append(node);
  });
  for (const extra of previous.slice(incoming.length)) extra.remove();
}
