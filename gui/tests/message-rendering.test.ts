// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderBlock } from "../src/views.js";

function answer(text: string): HTMLElement {
  return renderBlock({ kind: "assistant", id: "answer", at: 0, text, streaming: false }, {
    toggle: () => {}, undo: () => {},
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("readable, inert assistant Markdown", () => {
  it("renders headings, emphasis, inline code, lists and quoted text as readable structure", () => {
    const node = answer("## Ergebnis\n\n**Fertig** mit *Prüfung* und `npm test`.\n\n- Eintrag eins\n- Eintrag zwei\n\n1. Bauen\n2. Prüfen\n\n> Keine Zugangsdaten nötig.");
    expect(node.querySelector("h2")?.textContent).toBe("Ergebnis");
    expect(node.querySelector("strong")?.textContent).toBe("Fertig");
    expect(node.querySelector("em")?.textContent).toBe("Prüfung");
    expect(node.querySelector("p code")?.textContent).toBe("npm test");
    expect([...node.querySelectorAll("ul li")].map((item) => item.textContent)).toEqual(["Eintrag eins", "Eintrag zwei"]);
    expect([...node.querySelectorAll("ol li")].map((item) => item.textContent)).toEqual(["Bauen", "Prüfen"]);
    expect(node.querySelector("blockquote")?.textContent).toContain("Keine Zugangsdaten nötig.");
  });

  it("keeps raw HTML and image syntax inert and only links absolute HTTP(S) destinations", () => {
    const node = answer('<script>alert(1)</script>\n\n<img src="https://example.com/tracker" onerror="alert(1)">\n\n[Docs](https://example.com/docs) [HTTP](http://example.com/) [Bad](javascript:alert%281%29) [Data](data:text/html,boom) [File](file:///etc/passwd) [Relative](/local) ![Pixel](https://example.com/pixel.png)');
    expect(node.querySelector("script,img,iframe,object")).toBeNull();
    expect(node.textContent).toContain('<script>alert(1)</script>');
    expect([...node.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/docs", "http://example.com/",
    ]);
    for (const link of node.querySelectorAll("a")) {
      expect(link.rel).toContain("noopener");
      expect(link.rel).toContain("noreferrer");
    }
  });

  it("copies the exact fenced code, not Markdown or the control label", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const node = answer('```typescript\nconst a = "<unsafe>";\nconsole.log(a);\n```');
    expect(node.querySelector("pre code")?.textContent).toBe('const a = "<unsafe>";\nconsole.log(a);');
    const button = node.querySelector<HTMLButtonElement>("button");
    expect(button?.textContent).toBe("Code kopieren");
    button?.click();
    await vi.waitFor(() => expect(button?.textContent).toBe("Kopiert"));
    expect(writeText).toHaveBeenCalledWith('const a = "<unsafe>";\nconsole.log(a);');
  });

  it("reports clipboard refusal without claiming that code was copied", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("denied"); } } });
    const node = answer("```\nkeep this code\n```");
    const button = node.querySelector<HTMLButtonElement>("button");
    button?.click();
    await vi.waitFor(() => expect(node.querySelector('[role="status"]')?.textContent)
      .toBe("Kopieren nicht möglich. Code bitte markieren und kopieren."));
    expect(button?.textContent).toBe("Code kopieren");
    expect(node.querySelector("pre code")?.textContent).toBe("keep this code");
  });

  it("keeps unfinished fences readable during streaming and does not interpret their contents", () => {
    const node = answer("```html\n<h2>not a heading</h2>\n**literal**");
    expect(node.querySelector("pre code")?.textContent).toBe("<h2>not a heading</h2>\n**literal**");
    expect(node.querySelector("h2,strong")).toBeNull();
  });
});

it("shows a reported file change as a compact disclosure, retaining its exact inert diff", () => {
  const node = renderBlock({ kind: "file-change", id: "change", at: 1, path: "src/login.ts",
    tool: "apply_patch", created: false, added: 1, removed: 1, truncated: false,
    diff: "@@ -1 +1 @@\n-old\n+<script>inert</script>" }, { toggle: () => {}, undo: () => {} });
  expect(node.tagName).toBe("DETAILS");
  expect((node as HTMLDetailsElement).open).toBe(false);
  expect(node.querySelector("summary")?.textContent).toContain("src/login.ts");
  expect(node.querySelector("summary")?.textContent).toContain("+1 −1");
  expect(node.querySelector("summary")?.textContent).not.toContain("apply_patch");
  (node as HTMLDetailsElement).open = true;
  expect(node.textContent).toContain("apply_patch");
  expect(node.querySelectorAll(".diff-text")[1]?.textContent).toBe("<script>inert</script>");
  expect(node.querySelector("script")).toBeNull();
});
