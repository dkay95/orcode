/**
 * Markdown → spans (Bauplan 2.6). Markdown is *translated*, not stripped.
 *
 * Not translated (by decision, see non-goals): tables, syntax highlighting.
 */

import { displayWidth, wrapSpans } from "./compose.js";
import { span, type Line, type Span } from "./spans.js";
import type { Theme } from "./theme.js";

const INLINE =
  /(`+)([^`]*?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|(?<![A-Za-z0-9])_([^_\s][^_]*?)_(?![A-Za-z0-9])|\[([^\]]+?)\]\(([^)\s]+)\)/g;

/** Inline markup of a single logical line. */
export function inlineSpans(text: string, role: Span["role"] = "text"): Span[] {
  const out: Span[] = [];
  let cursor = 0;
  INLINE.lastIndex = 0;
  let match = INLINE.exec(text);
  while (match) {
    if (match.index > cursor) {
      out.push(span(text.slice(cursor, match.index), role));
    }
    const [, , code, strongStar, strongUnderscore, emStar, emUnderscore, label, url] =
      match;
    if (code !== undefined) {
      out.push(span(code, "structure"));
    } else if (strongStar !== undefined || strongUnderscore !== undefined) {
      out.push(span(strongStar ?? strongUnderscore ?? "", role, { bold: true }));
    } else if (emStar !== undefined || emUnderscore !== undefined) {
      out.push(span(emStar ?? emUnderscore ?? "", role, { underline: true }));
    } else if (label !== undefined && url !== undefined) {
      out.push(span(label, "accent"));
      out.push(span(" ", "text"));
      out.push(span(url, "muted"));
    }
    cursor = match.index + match[0].length;
    match = INLINE.exec(text);
  }
  if (cursor < text.length) {
    out.push(span(text.slice(cursor), role));
  }
  return out.length > 0 ? out : [span("", role)];
}

function emit(
  target: Line[],
  prefix: Span[],
  continuation: Span[],
  content: Span[],
  width: number,
): void {
  const prefixWidth = prefix.reduce((sum, item) => sum + displayWidth(item.text), 0);
  const inner = Math.max(1, width - prefixWidth);
  const wrapped = wrapSpans(content, inner);
  wrapped.forEach((wrappedLine, index) => {
    const lead = index === 0 ? prefix : continuation;
    target.push({ spans: [...lead.map((item) => ({ ...item })), ...wrappedLine.spans] });
  });
}

function pad(count: number): Span {
  return span(" ".repeat(Math.max(0, count)), "text");
}

/**
 * Renders markdown into lines of the given width. The caller adds its own
 * gutter; `width` is the space available for the markdown itself.
 */
export function markdownToLines(source: string, width: number, theme: Theme): Line[] {
  const lines: Line[] = [];
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  const edge = theme.glyph("blockEdge");
  const quote = theme.glyph("quoteGutter");

  let inCode = false;
  let codeLanguage = "";
  let codeFirst = true;

  for (const original of raw) {
    if (/^\s*```/.test(original)) {
      if (inCode) {
        inCode = false;
        codeLanguage = "";
      } else {
        inCode = true;
        codeFirst = true;
        codeLanguage = original.replace(/^\s*```/, "").trim();
      }
      continue;
    }

    if (inCode) {
      const prefix = [span(`${edge} `, "structure")];
      const body = span(original.replace(/\t/g, "  "), "structure");
      const inner = Math.max(1, width - displayWidth(`${edge} `));
      if (codeFirst && codeLanguage) {
        const languageWidth = displayWidth(codeLanguage);
        const textWidth = displayWidth(body.text);
        if (textWidth + 1 + languageWidth <= inner) {
          lines.push({
            spans: [
              ...prefix,
              body,
              pad(inner - textWidth - languageWidth),
              span(codeLanguage, "muted"),
            ],
          });
          codeFirst = false;
          continue;
        }
        lines.push({
          spans: [...prefix, pad(inner - languageWidth), span(codeLanguage, "muted")],
        });
      }
      codeFirst = false;
      emit(lines, prefix, prefix, [body], width);
      continue;
    }

    const value = original.replace(/\t/g, "  ");
    if (value.trim().length === 0) {
      lines.push({ spans: [] });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(value);
    if (heading) {
      const level = heading[1]!.length;
      const content = inlineSpans(heading[2]!, "accent").map((item) => ({
        ...item,
        role: item.role === "text" ? ("accent" as const) : item.role,
        bold: true,
      }));
      emit(lines, [pad(level - 1)], [pad(level - 1)], content, width);
      continue;
    }

    const quoted = /^\s*>\s?(.*)$/.exec(value);
    if (quoted) {
      const prefix = [span(`${quote} `, "muted")];
      emit(lines, prefix, prefix, inlineSpans(quoted[1]!, "muted"), width);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(value);
    if (bullet) {
      const depth = Math.floor(displayWidth(bullet[1]!) / 2);
      const prefix = [pad(depth * 2), span("– ", "structure")];
      const continuation = [pad(depth * 2 + 2)];
      emit(lines, prefix, continuation, inlineSpans(bullet[2]!), width);
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(value);
    if (numbered) {
      const depth = Math.floor(displayWidth(numbered[1]!) / 2);
      const label = `${numbered[2]}.`;
      const marker = label.padStart(3);
      const prefix = [pad(depth * 2), span(`${marker} `, "structure")];
      const continuation = [pad(depth * 2 + marker.length + 1)];
      emit(lines, prefix, continuation, inlineSpans(numbered[3]!), width);
      continue;
    }

    emit(lines, [], [], inlineSpans(value), width);
  }

  while (lines.length > 0 && lines[lines.length - 1]!.spans.length === 0) {
    lines.pop();
  }
  return lines;
}
