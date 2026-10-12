import { describe, expect, it } from "vitest";

import {
  REASONING_MAX_LINES,
  TAIL_CAPACITY,
  classifyToolOutcome,
  outputLines,
  selectTail,
} from "@core/utils";
import { toolMetadata } from "@core/tool-metadata";

import { ChatModel, type Block } from "../src/chat-model.js";
import { PROTOCOL_VERSION, type EventFrame } from "../src/protocol.js";

function runEvent(event: Record<string, unknown>): EventFrame {
  return { t: "event", v: PROTOCOL_VERSION, e: "run", event: { timestamp: 1, ...event } } as EventFrame;
}

function event(e: string, payload: Record<string, unknown> = {}): EventFrame {
  return { t: "event", v: PROTOCOL_VERSION, e, ...payload } as EventFrame;
}

function kinds(model: ChatModel): string[] {
  return model.blocks.map((block) => block.kind);
}

function tool(model: ChatModel): Extract<Block, { kind: "tool" }> {
  const block = model.blocks.find((entry) => entry.kind === "tool");
  if (!block || block.kind !== "tool") throw new Error("no tool block");
  return block;
}

describe("the answer", () => {
  it("streams through the assistant event and is not printed twice", () => {
    const model = new ChatModel();
    model.apply(event("assistant", { phase: "begin", model: "vendor/m" }));
    model.apply(event("assistant", { phase: "delta", delta: "Hel" }));
    // The same characters also arrive as a run event; rendering both would
    // duplicate the answer.
    model.apply(runEvent({ type: "text", delta: "Hel" }));
    model.apply(event("assistant", { phase: "delta", delta: "lo" }));
    model.apply(event("assistant", { phase: "end" }));
    expect(kinds(model)).toEqual(["assistant"]);
    const block = model.blocks[0];
    expect(block.kind === "assistant" && block.text).toBe("Hello");
    expect(block.kind === "assistant" && block.streaming).toBe(false);
  });

  it("adopts the run's own text when nothing streamed", () => {
    const model = new ChatModel();
    model.apply(event("assistant", { phase: "begin" }));
    model.apply(event("assistant", { phase: "end", text: "the whole answer" }));
    const block = model.blocks[0];
    expect(block.kind === "assistant" && block.text).toBe("the whole answer");
  });

  it("drops an assistant turn that never produced anything", () => {
    const model = new ChatModel();
    model.apply(event("assistant", { phase: "begin" }));
    model.apply(event("assistant", { phase: "end" }));
    expect(model.blocks).toHaveLength(0);
  });
});

describe("reasoning", () => {
  it("is one collapsed block, answer first (P15)", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "reasoning", delta: "step one " }));
    model.apply(runEvent({ type: "reasoning", delta: "step two" }));
    const block = model.blocks[0];
    expect(block.kind).toBe("reasoning");
    expect(block.kind === "reasoning" && block.text).toBe("step one step two");
    expect(block.kind === "reasoning" && block.collapsed).toBe(true);
    expect(model.reasoningLive).toBe(true);
  });

  it("stops being live when the model phase ends", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "reasoning", delta: "…" }));
    model.apply(runEvent({ type: "model-end", costUsd: 0, step: 1 }));
    expect(model.reasoningLive).toBe(false);
  });
});

describe("tools", () => {
  it("a tool still running when the run ends is never ok", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "run-start", model: "m", maxSteps: 5 }));
    model.apply(runEvent({ type: "tool-start", id: "t1", number: 1, name: "shell", input: { cmd: "ls" } }));
    model.apply(runEvent({ type: "run-end", outcome: "cancelled", durationMs: 10, toolCount: 1 }));
    expect(tool(model).state).toBe("cancelled");
  });

  it("becomes unverified rather than ok when the run ended any other way", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "run-start", model: "m", maxSteps: 5 }));
    model.apply(runEvent({ type: "tool-start", id: "t1", number: 1, name: "shell", input: {} }));
    model.apply(runEvent({ type: "run-end", outcome: "error", durationMs: 10, toolCount: 1 }));
    expect(tool(model).state).toBe("unverified");
  });

  it("reads its state from the tool's own result", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "tool-start", id: "t1", number: 1, name: "shell", input: {} }));
    model.apply(runEvent({ type: "tool-output", id: "t1", text: "a\nb\n" }));
    model.apply(runEvent({ type: "tool-end", id: "t1", number: 1, name: "shell", input: {}, output: { exitCode: 2 }, durationMs: 5 }));
    expect(tool(model).state).toBe("failed");
    expect(tool(model).exitCode).toBe(2);
    expect(tool(model).lines).toEqual(["a", "b"]);
    expect(tool(model).totalLines).toBe(2);
  });

  /**
   * The fork this pin exists for: a finished `write_file` reports `{ok:true,
   * path, bytes}` and no exit code. The terminal calls that **unverified**;
   * the window used to call it "done", which softened the
   * edits-are-unverified-until-verified rule on the write path of all
   * places. Both surfaces now run the same `classifyToolOutcome`.
   */
  it("calls a finished write unverified, exactly as the terminal does", () => {
    const output = { ok: true, path: "src/a.ts", bytes: 120 };
    const model = new ChatModel();
    model.apply(runEvent({ type: "tool-start", id: "w", number: 1, name: "write_file", input: { path: "src/a.ts" } }));
    model.apply(runEvent({
      type: "tool-end",
      id: "w",
      number: 1,
      name: "write_file",
      input: { path: "src/a.ts" },
      output,
      durationMs: 12,
    }));
    expect(tool(model).state).toBe("unverified");
    expect(tool(model).state).not.toBe("ok");
    expect(tool(model).exitCode).toBeUndefined();
    // Not a copy of the rule — the rule itself.
    expect(tool(model).state).toBe(classifyToolOutcome(output).state);
  });

  it("calls a null exit with a terminal reason a failed launch", () => {
    const output = { exitCode: null, stderr: "spawn ENOENT" };
    const model = new ChatModel();
    model.apply(runEvent({ type: "tool-start", id: "t", number: 1, name: "run_command", input: {} }));
    model.apply(runEvent({
      type: "tool-end",
      id: "t",
      number: 1,
      name: "run_command",
      input: {},
      output,
      durationMs: 3,
    }));
    expect(tool(model).state).toBe("failed");
    expect(tool(model).state).toBe(classifyToolOutcome(output).state);
    // No invented exit code for a process that never reported one.
    expect(tool(model).exitCode).toBeUndefined();
  });

  it("grades every shape the way the shared classifier does", () => {
    const shapes: unknown[] = [
      { exitCode: 0 },
      { exitCode: 1 },
      { exitCode: null, stderr: "   " },
      { ok: true },
      { ok: false },
      { aborted: true },
      "not an object",
      null,
    ];
    for (const [index, output] of shapes.entries()) {
      const model = new ChatModel();
      const id = `s${index}`;
      model.apply(runEvent({ type: "tool-start", id, number: 1, name: "shell", input: {} }));
      model.apply(runEvent({ type: "tool-end", id, number: 1, name: "shell", input: {}, output, durationMs: 1 }));
      expect(tool(model).state, JSON.stringify(output)).toBe(classifyToolOutcome(output).state);
    }
  });

  it("grades an unbound process end through the same classifier", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "process-start", id: "p", name: "git", input: {} }));
    model.apply(runEvent({
      type: "process-end",
      id: "p",
      name: "git",
      input: {},
      exitCode: 0,
      durationMs: 4,
      truncated: false,
      timedOut: false,
      aborted: false,
      stdout: "ok",
      stderr: "",
    }));
    expect(tool(model).state).toBe("ok");
    expect(tool(model).exitCode).toBe(0);
  });

  it("binds a process to its tool block, and gives an unbound one its own", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "tool-start", id: "t1", number: 1, name: "shell", input: {} }));
    model.apply(runEvent({ type: "process-start", id: "p1", name: "bash", input: {}, toolId: "t1" }));
    model.apply(runEvent({ type: "process-output", id: "p1", name: "bash", stream: "stdout", text: "bound\n" }));
    expect(model.blocks.filter((block) => block.kind === "tool")).toHaveLength(1);
    expect(tool(model).lines).toEqual(["bound"]);

    model.apply(runEvent({ type: "process-start", id: "p2", name: "git", input: {} }));
    model.apply(runEvent({ type: "process-output", id: "p2", name: "git", stream: "stdout", text: "loose\n" }));
    expect(model.blocks.filter((block) => block.kind === "tool")).toHaveLength(2);
  });
});

describe("the run's own figures", () => {
  it("accumulates cost and keeps an unknown sticky", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "run-start", model: "m", maxSteps: 3 }));
    model.apply(runEvent({ type: "model-end", costUsd: 0.01, step: 1 }));
    model.apply(runEvent({ type: "model-end", costUsd: 0.02, step: 2, costKnowledge: "unknown" }));
    model.apply(runEvent({ type: "model-end", costUsd: 0.03, step: 3 }));
    expect(model.run?.costUsd).toBeCloseTo(0.06);
    // Once any phase priced as unknown the total is a floor, not a total.
    expect(model.run?.costKnowledge).toBe("unknown");
  });

  it("marks the run inactive with its outcome, and states it in no block", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "run-start", model: "m", maxSteps: 3 }));
    expect(model.runActive).toBe(true);
    model.apply(runEvent({ type: "run-end", outcome: "cancelled", durationMs: 1200, toolCount: 2 }));
    expect(model.runActive).toBe(false);
    expect(model.run?.outcome).toBe("cancelled");
    // `view-model.ts`'s `run-end` case settles the open blocks and pushes
    // nothing: the sentence a person reads is the engine's own footer, which
    // arrives as a `system` transcript line and says outcome, cost and
    // model. A block here would be a second run-complete line with a
    // different fact set — the two footers the owner photographed.
    expect(model.blocks).toEqual([]);
  });
});

/**
 * A WHOLE run, in the exact order the sidecar puts it on the wire.
 *
 * Not composed by hand: these are every stream-bearing frame a real
 * `gui-server` child put on stdout for one `submit`, driven through
 * `tests/fixtures/gui-server-harness.mjs` (scenario `default`). Only the
 * timestamps are flattened, and only the `status`/`suggestions` frames — which
 * touch no block — are left out. The owner's duplicate-answer report is this
 * sequence: THREE events clear the live answer between the begin frame and
 * the end frame (`reasoning`, `tool-start`, `file-change`, and `run-end`
 * again after the deltas), so a reducer that keys the answer on "is a block
 * open right now" opens a fresh one every time and adopts the run's whole
 * text into the last of them.
 *
 *   assistant/begin … reasoning … tool-start … file-change …
 *   assistant/delta … run-end … assistant/end (the run's whole text) … footer
 *
 * `tests/gui-server-protocol.test.ts` pins that order on the wire, so if the
 * engine ever moves `assistant/end` before `run-end` this file is reducing
 * against a contract that is still true.
 */
const WIRE_RUN: readonly EventFrame[] = [
  event("transcript", { role: "user", content: "Hi" }),
  event("assistant", { phase: "begin", model: "vendor/gui-main" }),
  runEvent({ type: "run-start", model: "vendor/gui-main", maxSteps: 7, costKnowledge: "known" }),
  runEvent({ type: "model-start", model: "vendor/gui-main", step: 1 }),
  runEvent({ type: "reasoning", model: "vendor/gui-main", step: 1, delta: "Weighing the options." }),
  runEvent({ type: "tool-start", id: "t1", number: 1, name: "write_file", input: { path: "notes.md" } }),
  runEvent({ type: "process-start", id: "p1", name: "bash", input: { command: "echo hi" }, toolId: "t1", toolNumber: 1 }),
  runEvent({ type: "process-output", id: "p1", name: "bash", input: { command: "echo hi" }, stream: "stdout", text: "first half\nsecond line\n" }),
  runEvent({ type: "file-change", path: "notes.md", tool: "write_file", created: true, added: 1, removed: 0, diff: "+ hello", truncated: false }),
  runEvent({ type: "tool-end", id: "t1", number: 1, name: "write_file", input: { path: "notes.md" }, output: "ok", durationMs: 4 }),
  event("assistant", { phase: "delta", delta: "Hello world." }),
  // The run log's mirror of the same characters — already ignored.
  runEvent({ type: "text", delta: "Hello world." }),
  runEvent({ type: "run-end", outcome: "complete", durationMs: 9, toolCount: 1 }),
  // The FALLBACK, not a second answer: `finishAssistant(result.text)`.
  event("assistant", { phase: "end", text: "Hello world." }),
  // The engine's own completion line — the terminal's, byte for byte.
  event("transcript", { role: "system", content: "Run complete · $0.00200 · vendor/gui-main" }),
];

function replay(frames: readonly EventFrame[]): ChatModel {
  const model = new ChatModel();
  for (const frame of frames) model.apply(frame);
  return model;
}

describe("a whole run, as the wire delivers it", () => {
  it("shows the answer once, not once per block the stream opened", () => {
    const model = replay(WIRE_RUN);
    const answers = model.blocks.filter((block) => block.kind === "assistant");
    expect(answers.map((block) => (block.kind === "assistant" ? block.text : ""))).toEqual([
      "Hello world.",
    ]);
  });

  it("never leaves an empty answer block behind", () => {
    const model = replay(WIRE_RUN);
    const empty = model.blocks.filter(
      (block) => block.kind === "assistant" && block.text.trim() === "",
    );
    expect(empty).toEqual([]);
  });

  it("leaves nothing streaming once the run has ended", () => {
    const model = replay(WIRE_RUN);
    // The caret is painted from this flag alone; a stale `true` is the box
    // glyph the owner saw at the end of a finished answer.
    const streaming = model.blocks.filter(
      (block) => block.kind === "assistant" && block.streaming,
    );
    expect(streaming).toEqual([]);
    expect(model.reasoningLive).toBe(false);
  });

  it("states the run's outcome exactly once, in the engine's own words", () => {
    const model = replay(WIRE_RUN);
    // Every block that carries text, screened for a completion sentence —
    // whichever kind might be tempted to compose one.
    const completions = model.blocks
      .map((block) =>
        block.kind === "system" || block.kind === "notice" || block.kind === "assistant"
          ? block.text
          : "",
      )
      .filter((text) => /^Run (complete|cancelled|failed)|^Step limit|^Cost limit/.test(text));
    // Duration/tool-count is NOT the terminal's completion line: `runFooter`
    // states outcome, cost and routing. One source, one wording.
    expect(completions).toEqual(["Run complete · $0.00200 · vendor/gui-main"]);
  });

  it("keeps the whole run in the terminal's block order", () => {
    expect(kinds(replay(WIRE_RUN))).toEqual([
      "user",
      "reasoning",
      "tool",
      "file-change",
      "assistant",
      "system",
    ]);
  });
});

describe("edits", () => {
  it("keeps the diff and the counts the event carried", () => {
    const model = new ChatModel();
    model.apply(
      runEvent({
        type: "file-change",
        path: "src/a.ts",
        tool: "write_file",
        created: false,
        added: 3,
        removed: 1,
        diff: "@@ -1 +1 @@\n-a\n+b\n",
        truncated: true,
      }),
    );
    const block = model.blocks[0];
    expect(block.kind).toBe("file-change");
    expect(block.kind === "file-change" && block.added).toBe(3);
    expect(block.kind === "file-change" && block.truncated).toBe(true);
  });
});

describe("a transcript the client cannot follow", () => {
  it("is replaced by what the session now holds", () => {
    const model = new ChatModel();
    model.apply(event("transcript", { role: "user", content: "old" }));
    model.apply(
      event("chat.reset", {
        chatId: "c1",
        title: "Fresh",
        workspace: "/tmp/w",
        turnCount: 0,
        reason: "cleared",
        turns: [],
      }),
    );
    expect(model.blocks).toHaveLength(0);
    expect(model.chat?.title).toBe("Fresh");
  });

  it("loads the turns a chat switch handed over", () => {
    const model = new ChatModel();
    model.apply(
      event("chat.opened", {
        chatId: "c2",
        title: "Another",
        workspace: "/tmp/other",
        rerooted: true,
        turnCount: 2,
        untouched: false,
        turns: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      }),
    );
    expect(kinds(model)).toEqual(["user", "assistant"]);
    expect(model.lastOpened?.rerooted).toBe(true);
  });
});

describe("the stream reduction is the terminal's, function for function", () => {
  it("names a tool with toolMetadata's badge, title and input summary", () => {
    const model = new ChatModel();
    model.apply(runEvent({
      type: "tool-start",
      id: "t1",
      number: 1,
      name: "run_command",
      input: { command: "npm test", timeoutSeconds: 30 },
      timestamp: 1,
    }));
    const [block] = model.blocks;
    expect(block?.kind).toBe("tool");
    if (block?.kind !== "tool") throw new Error("not a tool block");
    // Not the raw name and not a three-key argument dump: the exact three
    // fields `toolMetadata` gives the terminal's own tool card.
    const meta = toolMetadata("run_command");
    expect(block.label).toBe(meta.label);
    expect(block.title).toBe(meta.title);
    expect(block.input).toBe(meta.summarizeInput({ command: "npm test", timeoutSeconds: 30 }));
    expect(block.label).not.toBe("run_command");
  });

  it("keeps the error lines of a failure, not the tail", () => {
    const model = new ChatModel();
    model.apply(runEvent({
      type: "tool-start", id: "t1", number: 1, name: "run_command",
      input: { command: "npm test" }, timestamp: 1,
    }));
    const stdout = [
      "compiling",
      "error TS2345: nope",
      ...Array.from({ length: 40 }, (_, index) => `trailing ${index}`),
    ].join("\n");
    model.apply(runEvent({
      type: "tool-end", id: "t1", durationMs: 12,
      output: { exitCode: 1, stdout }, timestamp: 2,
    }));
    const block = model.blocks.find((entry) => entry.kind === "tool");
    if (block?.kind !== "tool") throw new Error("not a tool block");
    expect(block.state).toBe("failed");
    // `selectTail`'s failure branch: the error lines, from the FRONT — a tail
    // would have shown "trailing 39" and hidden the reason.
    expect(block.lines).toEqual(selectTail(outputLines({ exitCode: 1, stdout }), true, REASONING_MAX_LINES));
    expect(block.lines[0]).toBe("error TS2345: nope");
  });

  it("reads the output keys the terminal reads, not a subset", () => {
    const model = new ChatModel();
    model.apply(runEvent({
      type: "tool-start", id: "t1", number: 1, name: "read_file",
      input: { path: "src/a.ts" }, timestamp: 1,
    }));
    // `content` is one of the five keys — a surface that only read stdout
    // would render this tool as having printed nothing at all.
    model.apply(runEvent({
      type: "tool-end", id: "t1", durationMs: 3,
      output: { ok: true, path: "src/a.ts", content: "one\ntwo" }, timestamp: 2,
    }));
    const block = model.blocks.find((entry) => entry.kind === "tool");
    if (block?.kind !== "tool") throw new Error("not a tool block");
    expect(block.lines).toEqual(["one", "two"]);
  });

  it("bounds a running tool at the terminal's own ring size", () => {
    const model = new ChatModel();
    model.apply(runEvent({
      type: "tool-start", id: "t1", number: 1, name: "run_command",
      input: { command: "yes" }, timestamp: 1,
    }));
    for (let index = 0; index < TAIL_CAPACITY + 50; index += 1) {
      model.apply(runEvent({ type: "tool-output", id: "t1", text: `line ${index}\n`, timestamp: 2 }));
    }
    const block = model.blocks.find((entry) => entry.kind === "tool");
    if (block?.kind !== "tool") throw new Error("not a tool block");
    expect(block.lines.length).toBe(TAIL_CAPACITY);
    expect(block.totalLines).toBe(TAIL_CAPACITY + 50);
  });
});

describe("setup's presentations", () => {
  it("renders a settled outcome durably and nothing else", () => {
    const model = new ChatModel();
    // A pre-prompt disclosure: it belongs to the prompt it precedes (the
    // engine folds it into the secret ask), so it is not a second block here.
    model.apply(event("setup.present", {
      presentation: { version: 1, type: "notice", message: "Validating the key …", busy: true },
    }));
    model.apply(event("setup.present", {
      presentation: { version: 1, type: "notice", message: "This key is billed to your own account." },
    }));
    // The provider-state frame is a list refresh, never a message.
    model.apply(event("setup.present", {
      presentation: { version: 1, type: "provider-state", entries: [] },
    }));
    expect(kinds(model)).toEqual([]);

    model.apply(event("setup.present", {
      presentation: {
        version: 1,
        type: "notice",
        outcome: true,
        title: "Kimi Code unavailable here",
        message: "Kimi Code can only be set up here in the terminal, on your own machine.",
      },
    }));
    expect(kinds(model)).toEqual(["notice"]);
    const notice = model.blocks[0] as Extract<Block, { kind: "notice" }>;
    expect(notice.text).toBe(
      "Kimi Code unavailable here — Kimi Code can only be set up here in the terminal, on your own machine.",
    );
  });
});

describe("the live Cross panel", () => {
  it("is the engine's own frame, and its absence is the engine's decision too", () => {
    const model = new ChatModel();
    expect(model.cross).toBeNull();
    const state = {
      sequence: 3,
      updatedAt: 100,
      phase: "Implementing",
      reason: null,
      verification: "Not run",
      lead: "gpt-5",
      challenger: "claude-4",
      active: true,
    };
    model.apply(event("cross", { state }));
    expect(model.cross).toEqual(state);
    // The engine says "no panel" by sending null — the client never re-derives
    // the visibility rule.
    model.apply(event("cross", { state: null }));
    expect(model.cross).toBeNull();
  });

  it("does not survive a transcript the client cannot follow", () => {
    const model = new ChatModel();
    model.apply(event("cross", {
      state: {
        sequence: 1, updatedAt: 1, phase: "Analysing", reason: null,
        verification: "Not run", lead: "a", challenger: "b", active: true,
      },
    }));
    model.apply(event("chat.reset", { chatId: "c", title: "t", workspace: "/w", turnCount: 0, turns: [] }));
    expect(model.cross).toBeNull();
  });
});

describe("the run's concluding line", () => {
  function footers(model: ChatModel): Extract<Block, { kind: "system" }>[] {
    return model.blocks.filter(
      (block): block is Extract<Block, { kind: "system" }> =>
        block.kind === "system" && block.footer !== undefined,
    );
  }

  it("marks the engine's own footer once per run, and never a second line", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "run-start", model: "m", maxSteps: 4 }));
    model.apply(runEvent({ type: "run-end", outcome: "complete" }));
    // `run-session.ts` writes this line immediately after the run resolves.
    model.apply(event("transcript", { role: "system", content: "Run complete · $0.002 · m" }));
    // Anything after it is transcript, not a second footer.
    model.apply(event("transcript", { role: "system", content: "Something else entirely" }));
    const marked = footers(model);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.text).toBe("Run complete · $0.002 · m");
    expect(marked[0]!.footer).toBe("complete");
  });

  it("never claims a labelled line — a notice belongs to itself", () => {
    const model = new ChatModel();
    model.apply(runEvent({ type: "run-start", model: "m", maxSteps: 4 }));
    model.apply(runEvent({ type: "run-end", outcome: "cancelled" }));
    model.apply(event("transcript", { role: "system", content: "A notice", meta: "Notice" }));
    model.apply(event("transcript", { role: "system", content: "Run cancelled · $0.001" }));
    const marked = footers(model);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.text).toBe("Run cancelled · $0.001");
    // A cancelled run is never a complete one, and the outcome rides along.
    expect(marked[0]!.footer).toBe("cancelled");
  });

  it("marks nothing outside a settled run", () => {
    const model = new ChatModel();
    model.apply(event("transcript", { role: "system", content: "A line with no run behind it" }));
    expect(footers(model)).toHaveLength(0);
    model.apply(runEvent({ type: "run-start", model: "m", maxSteps: 4 }));
    model.apply(event("transcript", { role: "system", content: "Mid-run chatter" }));
    expect(footers(model)).toHaveLength(0);
  });

  it("keeps the wire's `error` role rather than flattening it to a note", () => {
    const model = new ChatModel();
    model.apply(event("transcript", { role: "error", content: "The provider refused" }));
    const block = model.blocks[0];
    expect(block?.kind).toBe("system");
    expect(block?.kind === "system" && block.level).toBe("error");
  });
});
