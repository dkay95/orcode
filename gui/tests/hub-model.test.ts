import { describe, expect, it } from "vitest";

import { abbreviateHome, hubRows, statusSegments } from "../src/hub-model.js";
import type { ChatRow, GuiStatus } from "../src/protocol.js";

/**
 * The age comes from `formatChatRow`'s own clock (`relativeAge(Date.now(),
 * …)`), so a fixture dates itself against the real one rather than pinning
 * a wall-clock instant that would make the row read "33m ago" on a machine
 * whose day disagrees with the test's.
 */
const NOW = Date.now();

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    id: "c1",
    title: "A chat",
    workspace: "/Users/me/project",
    turnCount: 3,
    costUsd: 0.42,
    model: "vendor/qwen3.8-max",
    updatedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("recent rows", () => {
  it("carry the real facts, in the terminal's own wording", () => {
    const [entry] = hubRows([row()], "/Users/me/project", "/Users/me", NOW);
    expect(entry.title).toBe("A chat");
    expect(entry.detail).toBe("3 messages · $0.420 · qwen3.8-max · 2h ago");
    expect(entry.foreign).toBe(false);
  });

  it("append the folder only for a chat that lives somewhere else", () => {
    const [entry] = hubRows([row({ workspace: "/Users/me/other" })], "/Users/me/project", "/Users/me", NOW);
    expect(entry.detail).toContain("~/other");
    // A foreign row is the one whose opening RE-ROOTS the workspace.
    expect(entry.foreign).toBe(true);
  });

  it("never renders an unknown cost as a number", () => {
    const [entry] = hubRows(
      [row({ costKnowledge: "unknown", costUsd: 0 })],
      "/Users/me/project",
      "/Users/me",
      NOW,
    );
    expect(entry.detail).toContain("provider-managed / unknown");
    expect(entry.detail).not.toContain("$0.00 ");
  });

  it("says a partly known cost is a floor", () => {
    const [entry] = hubRows(
      [row({ costKnowledge: "unknown", costUsd: 0.5 })],
      "/Users/me/project",
      "/Users/me",
      NOW,
    );
    expect(entry.detail).toContain("at least $0.500");
    expect(entry.detail).toContain("further provider-managed costs unknown");
  });

  it("says 80+ at the retention cap instead of saturating quietly", () => {
    const [entry] = hubRows([row({ turnCount: 140 })], "/Users/me/project", "/Users/me", NOW);
    expect(entry.detail).toContain("80+ messages");
  });
});

describe("the home abbreviation", () => {
  it("shortens the owner's own paths and leaves others alone", () => {
    expect(abbreviateHome("/Users/me/x", "/Users/me")).toBe("~/x");
    expect(abbreviateHome("/Users/me", "/Users/me")).toBe("~");
    expect(abbreviateHome("/opt/x", "/Users/me")).toBe("/opt/x");
    expect(abbreviateHome("/opt/x", null)).toBe("/opt/x");
  });
});

function status(overrides: Partial<GuiStatus> = {}): GuiStatus {
  return {
    model: "vendor/main",
    resolvedModel: "vendor/main-resolved",
    workspace: "/Users/me/project",
    chatId: "c1",
    chatTitle: "A chat",
    approval: "ask",
    routeConnected: true,
    providerManaged: false,
    balanceRemainingUsd: 12.5,
    balanceHedged: true,
    lowBalanceThresholdUsd: 5,
    dayUsd: 0.42,
    sessionUsd: 0.1,
    sessionCostKnowledge: "known",
    runActive: false,
    executionMode: "piped",
    ownerPathsAllowed: false,
    ...overrides,
  };
}

describe("the status line's tri-states", () => {
  it("omits a figure the engine did not claim, rather than showing zero", () => {
    const segments = statusSegments(
      status({ dayUsd: undefined, balanceRemainingUsd: undefined }),
      "/Users/me",
    );
    expect(segments.today).toBeNull();
    expect(segments.balance).toBeNull();
  });

  it("says provider-managed instead of a number when that is the truth", () => {
    const segments = statusSegments(
      status({ providerManaged: true, balanceRemainingUsd: undefined }),
      "/Users/me",
    );
    expect(segments.balance).toBe("provider-managed");
  });

  it("hedges a session total the engine could not fully price", () => {
    const segments = statusSegments(status({ sessionCostKnowledge: "unknown" }), "/Users/me");
    // The FIGURE is the engine's, through the shared `formatUsd`; the words
    // around it are this window's own chrome, and Desktop v2's chrome is
    // German. The hedge itself is what matters and it is still there.
    expect(segments.session).toBe("mindestens $0.100 dieser Chat");
    expect(statusSegments(status(), "/Users/me").session).toBe("$0.100 dieser Chat");
  });

  it("splits a row into the parts the sidebar lays out, from the shared formatters", () => {
    const [entry] = hubRows([row()], "/Users/me/project", "/Users/me", NOW);
    // Each part is produced by the formatter `formatChatRow` composes with —
    // never cut out of the composed sentence — and the sentence itself stays
    // whole and reachable.
    expect(entry.cost).toBe("$0.420");
    expect(entry.model).toBe("qwen3.8-max");
    expect(entry.age).toBe("2h ago");
    expect(entry.folder).toBeNull();
    expect(entry.detail).toContain(entry.cost);
    expect(entry.detail).toContain(entry.model);

    const [away] = hubRows([row({ workspace: "/Users/me/other" })], "/Users/me/project", "/Users/me", NOW);
    expect(away.folder).toBe("~/other");

    const [unpriced] = hubRows(
      [row({ costKnowledge: "unknown", costUsd: 0 })],
      "/Users/me/project",
      "/Users/me",
      NOW,
    );
    // The unknown cost keeps its hedge in the part, too — never a bare $0.
    expect(unpriced.cost).toBe("provider-managed / unknown");
  });

  it("marks a low balance as low", () => {
    expect(statusSegments(status({ balanceRemainingUsd: 1 }), "/Users/me").balanceLow).toBe(true);
    expect(statusSegments(status(), "/Users/me").balanceLow).toBe(false);
  });

  it("keeps `routeConnected` a tri-state", () => {
    expect(statusSegments(status({ routeConnected: undefined }), null).routeConnected).toBeUndefined();
    expect(statusSegments(status({ routeConnected: false }), null).routeConnected).toBe(false);
  });
});
