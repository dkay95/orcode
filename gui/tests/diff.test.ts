// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { parseUnifiedDiff, splitHunks } from "@core/diff-parse";

import { AskQueue, type PendingAsk } from "../src/asks.js";
import { headerOf, readApprovalDiff, readDiff, renderDiffView } from "../src/diff.js";
import { PROTOCOL_VERSION, type AskFrame } from "../src/protocol.js";
import { askPanel } from "../src/views.js";

/** The literal shape `changePreview` (workspace.ts) hands an approval. */
const WRITE_PREVIEW_DETAILS = [
  "5 → 5 lines, 24 → 24 bytes, +1/-1",
  "--- before",
  "+++ after",
  "@@ -1,4 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  " four",
].join("\n");

function ask(kind: string, payload: Record<string, unknown> = {}): PendingAsk {
  const queue = new AskQueue();
  return queue.push({ t: "ask", v: PROTOCOL_VERSION, askId: `a-${kind}`, kind, ...payload } as AskFrame);
}

describe("the diff view", () => {
  it("is the engine's own reader, not a second parser", () => {
    const view = readDiff(WRITE_PREVIEW_DETAILS, { added: 1, removed: 1, truncated: false });
    // Identical to what the terminal's own reduction produces from the same
    // text: same hunks, same lines, same numbers.
    expect(view.hunks).toEqual(splitHunks(parseUnifiedDiff(WRITE_PREVIEW_DETAILS).lines));
  });

  it("keeps the file's own counts, never the parser's", () => {
    // The parser can only count what survived the differ's budget; the event
    // carries the file's real +N/-M. A view that recounted would understate.
    const view = readDiff(WRITE_PREVIEW_DETAILS, { added: 40, removed: 12, truncated: true });
    expect(view.added).toBe(40);
    expect(view.removed).toBe(12);
    expect(view.truncated).toBe(true);
  });

  it("renders the gutter, the line number and the sign", () => {
    const node = renderDiffView(
      readDiff(WRITE_PREVIEW_DETAILS, { added: 1, removed: 1, truncated: false }),
    );
    const rows = [...node.querySelectorAll(".diff-line")];
    expect(rows.length).toBe(5);
    const removed = rows.find((row) => row.classList.contains("del"))!;
    expect(removed.querySelector(".diff-edge")!.textContent).toBe("│");
    expect(removed.querySelector(".diff-number")!.textContent!.trim()).toBe("2");
    expect(removed.querySelector(".diff-sign")!.textContent).toBe("−");
    expect(removed.querySelector(".diff-text")!.textContent).toBe("two");
    const added = rows.find((row) => row.classList.contains("add"))!;
    expect(added.querySelector(".diff-number")!.textContent!.trim()).toBe("2");
    expect(added.querySelector(".diff-text")!.textContent).toBe("TWO");
  });

  it("says what a cap left out instead of cutting silently", () => {
    // Four separated changes — the shape `formatUnifiedDiff` emits for a file
    // touched in four places. The cap shows three.
    const hunk = (start: number): string[] => [
      `@@ -${start},3 +${start},3 @@`,
      ` before ${start}`,
      `-old ${start}`,
      `+new ${start}`,
      ` after ${start}`,
    ];
    const text = [
      "--- before",
      "+++ after",
      ...hunk(1),
      ...hunk(20),
      ...hunk(40),
      ...hunk(60),
    ].join("\n");
    const view = readDiff(text, { added: 4, removed: 4, truncated: true });
    expect(view.hunks.length).toBe(3);
    expect(view.hiddenHunks).toBe(1);
    const node = renderDiffView(view);
    expect(node.querySelector(".diff-note")!.textContent).toContain("1 more hunk(s) not shown");
    expect(node.querySelector(".diff-note")!.textContent).toContain("more changed lines not shown");
  });
});

describe("an approval that is about a file", () => {
  it("shows the parsed hunks, not the raw preview text", () => {
    const panel = askPanel(
      ask("approval", {
        preview: {
          name: "write_file",
          risk: "write",
          summary: "Overwrite file: src/a.ts",
          details: WRITE_PREVIEW_DETAILS,
        },
        danger: true,
        rememberAvailable: false,
        reasonAvailable: false,
      }),
      { answer: () => {}, decline: () => {} },
    );
    const rows = [...panel.querySelectorAll(".diff-line")];
    expect(rows.length).toBe(5);
    // The size header is kept (it is the only part of the preview text the
    // hunks do not carry); the `--- before` / `@@` scaffolding is not shown
    // as prose any more.
    expect(panel.textContent).toContain("5 → 5 lines");
    expect(panel.textContent).not.toContain("@@ -1,4 +1,4 @@");
    expect(panel.textContent).not.toContain("--- before");
  });

  it("leaves a prose preview alone", () => {
    const details = "- old text\n+ new text";
    expect(readApprovalDiff(details)).toBeNull();
    const panel = askPanel(
      ask("approval", {
        preview: { name: "replace_text", risk: "write", summary: "1 replacement(s)", details },
        danger: true,
        rememberAvailable: false,
        reasonAvailable: false,
      }),
      { answer: () => {}, decline: () => {} },
    );
    expect(panel.querySelectorAll(".diff-line").length).toBe(0);
    expect(panel.textContent).toContain("+ new text");
  });

  it("keeps the size header out of the hunks", () => {
    expect(headerOf(WRITE_PREVIEW_DETAILS)).toBe("5 → 5 lines, 24 → 24 bytes, +1/-1");
    expect(headerOf("@@ -1,1 +1,1 @@\n-a\n+b")).toBe("");
  });
});
