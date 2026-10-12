import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contextFillPercent } from "../src/agent.js";
import { estimateTokensFromChars } from "../src/utils.js";
import { COMMAND_CATALOG, resolveSlashCommand } from "../src/command-catalog.js";
import {
  handleSlashCommand,
  renderContextLines,
  type CommandContext,
  type ContextViewSession,
} from "../src/commands.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SessionStore } from "../src/session.js";
import { createTheme } from "../src/ui/theme.js";
import { plainText } from "../src/ui/spans.js";

function fakeContext(session: SessionStore, overrides: Partial<CommandContext> = {}): {
  context: CommandContext;
  output: string[];
} {
  const output: string[] = [];
  return {
    context: {
      workspace: session.data.workspace,
      session,
      config: structuredClone(DEFAULT_CONFIG),
      out: {
        text: (value: string) => output.push(value),
        error: (value: string) => output.push(value),
      },
      ...overrides,
    } as unknown as CommandContext,
    output,
  };
}

async function tempRoot(prefix: string): Promise<{ workspace: string; appHome: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `orcode-context-cmd-${prefix}-`));
  return {
    workspace: join(root, "project"),
    appHome: join(root, ".orcode"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("the /context catalog entry lives in the Chat group and documents both subcommands", () => {
  const entry = COMMAND_CATALOG.find((command) => command.name === "context");
  assert.ok(entry, "/context must be registered in the shared catalog");
  assert.equal(entry!.handlerId, "context");
  assert.match(entry!.usage, /pin <n>/);
  assert.match(entry!.usage, /unpin <n>/);
});

// FIX-15 (command-IA, ratified): pinning was a door an owner looks for and
// could not find. `pin` is an ALIAS of `/context` — the same handler, one
// catalog row — so `/pin` opens the very view whose row numbers
// `/context pin <n>` needs, and that view already prints the pin syntax.
test("/pin is an alias of /context, not a second command", () => {
  const entry = COMMAND_CATALOG.find((command) => command.name === "context");
  assert.deepEqual([...("aliases" in entry! ? entry.aliases : [])], ["pin"]);
  assert.equal(COMMAND_CATALOG.filter((command) => command.handlerId === "context").length, 1);
  assert.equal(resolveSlashCommand("/pin")?.handlerId, "context");
  assert.deepEqual([...(resolveSlashCommand("/pin")?.args ?? [])], []);
  assert.deepEqual(
    resolveSlashCommand("/pin 3"),
    resolveSlashCommand("/context 3"),
    "the alias may never mean something the canonical spelling does not",
  );
});

test("renderContextLines reflects real window composition from a fake store — summary, tool calls, and turns in order", () => {
  const fake: ContextViewSession = {
    summary: "condensed earlier history",
    summaryUpdatedAt: "2026-08-20T10:00:00.000Z",
    turns: [
      { role: "user", content: "first message", createdAt: "2026-08-21T09:00:00.000Z", id: "turn-a" },
      { role: "assistant", content: "first reply", createdAt: "2026-08-21T09:00:05.000Z", id: "turn-b" },
    ],
    toolCalls: [
      { name: "run_command", summary: "npm test", turnIndex: 1, at: "2026-08-21T09:00:03.000Z" },
    ],
    pinnedTurns: ["turn-a"],
  };
  const theme = createTheme({ level: 0 });
  const lines = renderContextLines(fake, null, theme).map((line) => plainText(line));
  const text = lines.join("\n");

  // Summary row, labeled with when it was folded.
  assert.match(text, /Compressed summary/);
  assert.match(text, /folded/);
  // Both turns present, numbered 1 and 2 in chronological order.
  assert.match(text, /1\. You/);
  assert.match(text, /2\. orcode/);
  // The tool call is interleaved right before the turn at its turnIndex (1),
  // i.e. between turn 1 and turn 2 — matching exportSessionMarkdown's own
  // turnIndex-based grouping.
  const toolLine = lines.findIndex((line) => line.includes("run_command"));
  const turn1Line = lines.findIndex((line) => line.includes("1. You"));
  const turn2Line = lines.findIndex((line) => line.includes("2. orcode"));
  assert.ok(toolLine > turn1Line && toolLine < turn2Line, "the tool call must sit between the turns it happened around");
  // The pinned turn (turn-a, row 1) carries a pinned marker; the other does not.
  assert.match(lines[turn1Line]!, /pinned/);
  assert.doesNotMatch(lines[turn2Line]!, /pinned/);
  // Honesty: the estimate label appears, and every per-row token count uses
  // the shared estimator, not a fabricated number.
  assert.match(text, /estimates/);
  const expectedTurnTokens = estimateTokensFromChars("USER:\nfirst message".length);
  assert.match(text, new RegExp(`${expectedTurnTokens} tokens`));
});

test("D9: renderContextLines lists the standing goal as its own composition row, ahead of the compressed summary", () => {
  const fake: ContextViewSession = {
    summary: "condensed earlier history",
    summaryUpdatedAt: "2026-08-20T10:00:00.000Z",
    turns: [
      { role: "user", content: "first message", createdAt: "2026-08-21T09:00:00.000Z", id: "turn-a" },
    ],
    toolCalls: [],
    goal: "Keep every change backwards compatible",
  };
  const theme = createTheme({ level: 0 });
  const lines = renderContextLines(fake, null, theme).map((line) => plainText(line));
  const text = lines.join("\n");

  assert.match(text, /Standing goal/);
  assert.match(text, /Keep every change backwards compatible/);
  const goalLine = lines.findIndex((line) => line.includes("Standing goal"));
  const summaryLine = lines.findIndex((line) => line.includes("Compressed summary"));
  assert.ok(goalLine >= 0 && summaryLine >= 0 && goalLine < summaryLine, "the goal row must precede the summary row");
  // Token count uses the same shared estimator as every other row.
  const expectedGoalTokens = estimateTokensFromChars("Keep every change backwards compatible".length);
  assert.match(lines[goalLine]!, new RegExp(`${expectedGoalTokens} tokens`));
});

test("D9: renderContextLines shows the goal row even on a chat with no history yet — it is injected on every run regardless of turns", () => {
  const fake: ContextViewSession = { summary: "", turns: [], toolCalls: [], goal: "Ship it" };
  const theme = createTheme({ level: 0 });
  const text = renderContextLines(fake, null, theme).map((line) => plainText(line)).join("\n");
  assert.match(text, /Standing goal/);
  assert.match(text, /Ship it/);
  assert.match(text, /No chat history yet/);
});

test("D9: renderContextLines shows no standing-goal row when no goal is set", () => {
  const fake: ContextViewSession = {
    summary: "",
    turns: [{ role: "user", content: "hi", createdAt: "2026-08-21T09:00:00.000Z", id: "turn-a" }],
    toolCalls: [],
  };
  const theme = createTheme({ level: 0 });
  const text = renderContextLines(fake, null, theme).map((line) => plainText(line)).join("\n");
  assert.doesNotMatch(text, /Standing goal/);
});

test("renderContextLines shows an honest 'not yet measured' meter when no run has completed", () => {
  const fake: ContextViewSession = { summary: "", turns: [], toolCalls: [] };
  const theme = createTheme({ level: 0 });
  const text = renderContextLines(fake, null, theme).map((line) => plainText(line)).join("\n");
  assert.match(text, /not yet measured/);
  assert.doesNotMatch(text, /Context: \d/);
});

test("meter-source-unification: /context's lead line uses the exact same contextFillPercent computation the header uses", () => {
  const lastUsage = { inputTokens: 51_200, contextLength: 128_000 };
  const theme = createTheme({ level: 0 });
  const fake: ContextViewSession = { summary: "", turns: [], toolCalls: [] };
  const text = renderContextLines(fake, lastUsage, theme).map((line) => plainText(line)).join("\n");

  const expectedPercent = contextFillPercent(lastUsage.inputTokens, lastUsage.contextLength);
  assert.equal(expectedPercent, 40);
  assert.match(text, /Context: 40% of/);
  assert.match(text, /51,200 tokens/);
});

test("/context view is reachable through handleSlashCommand and reads OrcodeAgent.lastUsage for its meter", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("view-dispatch");
  try {
    const session = SessionStore.create(workspace, appHome, "Context view");
    session.addTurn("user", "hello");
    session.addTurn("assistant", "hi there");
    const fakeAgent = { lastUsage: { inputTokens: 1_000, contextLength: 10_000 } };
    const { context, output } = fakeContext(session, { agent: fakeAgent } as unknown as Partial<CommandContext>);

    await handleSlashCommand("/context", context);
    const text = output.join("\n");
    assert.match(text, /Context: 10% of/);
    assert.match(text, /1. You/);
    assert.match(text, /2. orcode/);
  } finally {
    await cleanup();
  }
});

test("/context pin <n> and /context unpin <n> resolve the row number against the cached view (fresh view, then act) and persist", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("pin-dispatch");
  try {
    const session = SessionStore.create(workspace, appHome, "Pin dispatch");
    session.addTurn("user", "pin row 1");
    session.addTurn("assistant", "row 2, never pinned");
    const firstTurnId = session.data.turns[0]!.id;
    const { context, output } = fakeContext(session);

    // Fix round 1: pin/unpin only ever resolve against a row the CURRENT
    // process just viewed — a bare pin with no prior /context call refuses
    // (covered in its own test below), so a fresh view always comes first.
    await handleSlashCommand("/context", context);
    output.length = 0;

    await handleSlashCommand("/context pin 1", context);
    assert.match(output.join("\n"), /Pinned turn 1/);
    assert.deepEqual(context.session.data.pinnedTurns, [firstTurnId]);

    const persisted = JSON.parse(await readFile(context.session.path, "utf8")) as { pinnedTurns?: string[] };
    assert.deepEqual(persisted.pinnedTurns, [firstTurnId]);

    output.length = 0;
    await handleSlashCommand("/context", context);
    const viewText = output.join("\n");
    const pinnedLine = viewText.split("\n").find((line) => line.includes("1. You"));
    assert.match(pinnedLine ?? "", /pinned/);

    // Unpinning after that same fresh view: the turns array hasn't changed
    // (pinning never mutates `turns`), so the cached snapshot is still good.
    output.length = 0;
    await handleSlashCommand("/context unpin 1", context);
    assert.match(output.join("\n"), /Unpinned turn 1/);
    assert.equal(context.session.data.pinnedTurns, undefined);

    output.length = 0;
    await handleSlashCommand("/context unpin 1", context);
    assert.match(output.join("\n"), /was not pinned/);
  } finally {
    await cleanup();
  }
});

test("/context pin|unpin <n> refuse honestly with no prior view, instead of resolving against the live array", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("pin-no-view");
  try {
    const session = SessionStore.create(workspace, appHome, "Pin no view");
    session.addTurn("user", "only turn");
    const { context } = fakeContext(session);

    // Never called /context in this context — there is no cached mapping.
    await assert.rejects(
      handleSlashCommand("/context pin 1", context),
      /The context view has changed — run \/context again\./,
    );
    assert.equal(context.session.data.pinnedTurns, undefined, "nothing may be pinned on a stale/missing view");

    await assert.rejects(
      handleSlashCommand("/context unpin 1", context),
      /The context view has changed — run \/context again\./,
    );
  } finally {
    await cleanup();
  }
});

test("/context pin <n> reports a genuine out-of-range row distinctly from a stale view", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("pin-missing-row");
  try {
    const session = SessionStore.create(workspace, appHome, "Pin missing row");
    session.addTurn("user", "only turn");
    const { context } = fakeContext(session);

    await handleSlashCommand("/context", context);
    // The view is fresh and matches the live session exactly — row 5 is a
    // plain out-of-range number, not a staleness problem, so it gets the
    // more specific message.
    await assert.rejects(handleSlashCommand("/context pin 5", context), /No turn numbered 5/);
    await assert.rejects(handleSlashCommand("/context pin abc", context), /Usage: \/context pin/);
    await assert.rejects(handleSlashCommand("/context bogus", context), /Usage: \/context/);
  } finally {
    await cleanup();
  }
});

test("CRITICAL fix round 1 — the reviewer's exact repro: a view followed by an automatic compression cycle makes pin <n> refuse instead of pinning the wrong turn", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("pin-stale-after-compaction");
  try {
    const session = SessionStore.create(workspace, appHome, "Pin stale after compaction");
    for (let index = 0; index < 10; index += 1) {
      session.addTurn(index % 2 === 0 ? "user" : "assistant", `turn ${index}`);
    }
    const rowThreeTurnBeforeCompaction = session.data.turns[2]!;
    const { context, output } = fakeContext(session);

    // Step 1: the user views the context — 10 rows, row 3 is a specific turn.
    await handleSlashCommand("/context", context);
    output.length = 0;

    // Step 2: an ordinary, fully automatic compression cycle runs in
    // between (agent.ts:1538-1540) — setSummary + compactTurns(4) — same as
    // a real run would do, entirely outside the user's /context interaction.
    context.session.setSummary("condensed handoff replacing most of the history");
    context.session.compactTurns(4);
    assert.notEqual(
      context.session.data.turns[2]?.id,
      rowThreeTurnBeforeCompaction.id,
      "the compaction must actually have changed what row 3 means, or this test proves nothing",
    );

    // Step 3: the user, still looking at the view from Step 1, asks to pin
    // row 3 — this MUST refuse rather than pin whatever turn now sits there.
    await assert.rejects(
      handleSlashCommand("/context pin 3", context),
      /The context view has changed — run \/context again\./,
    );
    assert.equal(
      context.session.data.pinnedTurns,
      undefined,
      "nothing must be pinned — least of all the wrong turn the user never saw at row 3",
    );

    // Same rule for unpin: pretend row 3 had looked pinned in the stale view.
    await assert.rejects(
      handleSlashCommand("/context unpin 3", context),
      /The context view has changed — run \/context again\./,
    );

    // A fresh view afterwards resolves normally against the new state.
    output.length = 0;
    await handleSlashCommand("/context", context);
    output.length = 0;
    await handleSlashCommand("/context pin 1", context);
    assert.match(output.join("\n"), /Pinned turn 1/);
  } finally {
    await cleanup();
  }
});

test("a pin survives fork inheritance end to end through the /context view", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("pin-fork-view");
  try {
    const session = SessionStore.create(workspace, appHome, "Pin fork view");
    session.addTurn("user", "keep me pinned across the fork");
    const { context } = fakeContext(session);
    await handleSlashCommand("/context", context);
    await handleSlashCommand("/context pin 1", context);

    const fork = await context.session.fork();
    const { context: forkContext, output: forkOutput } = fakeContext(fork);
    await handleSlashCommand("/context", forkContext);
    const forkedLine = forkOutput.join("\n").split("\n").find((line) => line.includes("1. You"));
    assert.match(forkedLine ?? "", /pinned/, "the forked chat's /context view must still show the inherited pin");
  } finally {
    await cleanup();
  }
});

test("a chat switch invalidates the cached view: pinning against a different chat's context refuses", async () => {
  const { workspace, appHome, cleanup } = await tempRoot("pin-chat-switch");
  try {
    const chatA = SessionStore.create(workspace, appHome, "Chat A");
    chatA.addTurn("user", "chat A's only turn");
    const chatB = SessionStore.create(workspace, appHome, "Chat B");
    chatB.addTurn("user", "chat B's only turn");
    const { context } = fakeContext(chatA);

    await handleSlashCommand("/context", context); // caches chat A's row 1
    // Simulate the REPL loop switching the same long-lived context to a
    // different chat without re-viewing it.
    (context as { session: SessionStore }).session = chatB;

    await assert.rejects(
      handleSlashCommand("/context pin 1", context),
      /The context view has changed — run \/context again\./,
    );
    assert.equal(chatB.data.pinnedTurns, undefined);
  } finally {
    await cleanup();
  }
});

/**
 * FIX-21 finding 5 (visual audit 2026-08-28, frame-verified): `/context`'s
 * tool row composed a raw `—` and a raw `·` while the elbow beside them went
 * through the theme, so the row asciified only half-way. Pinned in ASCII
 * mode, where a leak is a visible non-ASCII byte rather than a nuance.
 */
test("the /context tool row is pure ASCII in ascii glyph mode — no raw em dash, no raw middot (FIX-21 finding 5)", () => {
  const fake: ContextViewSession = {
    summary: "",
    turns: [
      { role: "user", content: "first message", createdAt: "2026-08-21T09:00:00.000Z", id: "turn-a" },
    ],
    toolCalls: [
      { name: "run_command", summary: "npm test", turnIndex: 0, at: "2026-08-21T09:00:03.000Z" },
    ],
  };
  const ascii = createTheme({ level: 0, ascii: true });
  const lines = renderContextLines(fake, null, ascii).map((line) => plainText(line));
  const toolRow = lines.find((row) => row.includes("run_command"));
  assert.ok(toolRow, "the tool composition row must render");
  assert.doesNotMatch(toolRow, /[^\x00-\x7f]/u, toolRow);
  // The whole view, not just the one row — a leak anywhere on this surface
  // is the same defect.
  const leaks = lines.filter((row) => /[^\x00-\x7f]/u.test(row));
  assert.deepEqual(leaks, [], `ascii /context must not emit non-ASCII: ${JSON.stringify(leaks)}`);
  // And the meaning survives: the summary clause and the token estimate are
  // still set off from the tool name, by the ASCII pairs.
  assert.match(toolRow, /tool: run_command - npm test - ~\d+ tokens/u);
});
