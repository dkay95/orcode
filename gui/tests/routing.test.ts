import { describe, expect, it } from "vitest";

import { routeComposerLine } from "../src/routing.js";

describe("what a composer line is", () => {
  it("never lets an idle slash line become a message", () => {
    // The exact hazard: `/undo` as a paid model run.
    expect(routeComposerLine("/undo", false)).toBe("command");
    expect(routeComposerLine("/cross off", false)).toBe("command");
    expect(routeComposerLine("/chat delete abc", false)).toBe("command");
  });

  it("keeps mid-run parity: every line interjects, slash included", () => {
    // `tui.ts`'s `!runOwnsTheLine &&` — while the run owns the line the
    // terminal feeds it to the running task, so this is parity not a hole.
    expect(routeComposerLine("/undo", true)).toBe("interject");
    expect(routeComposerLine("keep going", true)).toBe("interject");
  });

  it("sends an ordinary line as a message", () => {
    expect(routeComposerLine("write the notes", false)).toBe("submit");
    // A line that only MENTIONS a path is still a message.
    expect(routeComposerLine("look at src/a.ts", false)).toBe("submit");
  });
});
