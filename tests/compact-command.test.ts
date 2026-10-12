import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrcodeAgent } from "../src/agent.js";
import { ApprovalManager } from "../src/approval.js";
import { COMMAND_CATALOG, COMMAND_TREE, resolveSlashCommand } from "../src/command-catalog.js";
import { handleSlashCommand, type CommandContext } from "../src/commands.js";
import { commandRequiresRunnableRoute } from "../src/cli.js";
import { DEFAULT_CONFIG, type OrcodeConfigWithBudget } from "../src/config.js";
import { uncompressedContext } from "../src/compressor.js";
import type { OpenRouterService } from "../src/openrouter.js";
import { SessionStore } from "../src/session.js";

// ---------------------------------------------------------------------------
// /compact (FIX-2, audit 2026-08-28: the command simply did not exist —
// `/compress` is configuration only). One compression pass, now, on demand.
//
// These tests drive the REAL machinery end to end: a real `SessionStore`, a
// real `OrcodeAgent`, the real shared `compressContext`. Only the model call
// itself is faked, so "reuses the auto path's compressor" is something the
// assertions actually prove rather than assume.
// ---------------------------------------------------------------------------

const HEALTHY_BALANCE = {
  key: { limit: 10, limitRemaining: 8, usage: 2 },
  credits: { totalCredits: 20, totalUsage: 4, remaining: 16 },
};

function compressorClient(handoff: () => string, costUsd = 0.002): {
  client: unknown;
  calls: number;
  inputs: string[];
} {
  const state = {
    calls: 0,
    inputs: [] as string[],
    client: {
      callModel(request: { input: string }) {
        state.calls += 1;
        state.inputs.push(request.input);
        return {
          getText: async () => handoff(),
          getResponse: async () => ({ usage: { cost: costUsd } }),
        };
      },
    },
  };
  return state;
}

function service(client: unknown, compressorModel: string): OpenRouterService {
  return {
    client: () => client,
    checkBalance: async () => HEALTHY_BALANCE,
    onConnectionEvent: () => () => {},
    safeMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    listModels: async () => [{
      id: compressorModel,
      name: compressorModel,
      contextLength: 128_000,
      promptPrice: 0.000_000_1,
      completionPrice: 0.000_000_2,
    }],
  } as unknown as OpenRouterService;
}

interface Harness {
  session: SessionStore;
  config: OrcodeConfigWithBudget;
  context: CommandContext;
  lines: string[];
  compressor: ReturnType<typeof compressorClient>;
  cleanup: () => Promise<void>;
}

async function harness(options: {
  label: string;
  turns?: number;
  handoff?: () => string;
  costUsd?: number;
  config?: Partial<OrcodeConfigWithBudget>;
} ): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), `orcode-compact-${options.label}-`));
  const workspace = join(root, "project");
  const appHome = join(root, ".orcode");
  await mkdir(workspace, { recursive: true });
  const session = await SessionStore.open(workspace, appHome);
  const config: OrcodeConfigWithBudget = {
    ...DEFAULT_CONFIG,
    ...options.config,
    reasoningByModel: {},
    budget: { ...DEFAULT_CONFIG.budget, ...options.config?.budget },
  };
  for (let index = 0; index < (options.turns ?? 0); index += 1) {
    session.addTurn(
      index % 2 === 0 ? "user" : "assistant",
      `Turn ${index}: a reasonably long line of chat content so the transcript is not trivially small.`,
    );
  }
  await session.save();
  const compressor = compressorClient(
    options.handoff ?? (() => "Dense handoff: the task, the constraints, the open work."),
    options.costUsd ?? 0.002,
  );
  const agent = await OrcodeAgent.create({
    openRouter: service(compressor.client, config.compressorModel),
    approvals: new ApprovalManager("read-only"),
    session,
    config,
    workspace,
  });
  const lines: string[] = [];
  const context = {
    workspace,
    session,
    config,
    agent,
    approvals: new ApprovalManager("read-only"),
    out: {
      text: (value: string) => lines.push(value),
      error: (value: string, hint?: string) => lines.push(hint ? `${value}\n${hint}` : value),
    },
    // D4: `/compact` is the user's own explicit action, so it must never ask
    // again. Every confirmation seam this file's dispatch could reach throws
    // if it is touched at all.
    // FIX-14 ticket 6: one seam covers what four separate ports used to.
    confirm: async () => { throw new Error("no confirmation may be asked"); },
  } as unknown as CommandContext;
  return {
    session,
    config,
    context,
    lines,
    compressor,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// FIX-15 (command-IA, ratified) moved this pin DELIBERATELY. It used to
// assert "/compact sits next to /compress, in /compress's group" — written
// when the pair was introduced, to stop the two drifting apart. The audit
// separated them on purpose: `/compress` chooses a MODEL and a policy, so it
// stays in Models; `/compact` acts on THIS chat's context window, right now,
// so it belongs in Chat beside `/context` — the very thing it shortens. The
// anti-drift intent survives as the new adjacency: `/compact` follows
// `/context`, and the cross-reference between the two commands is still
// asserted by the `/compress` output test further down this file.
test("/compact is catalogued next to /context, in the Chat group, and takes no arguments", () => {
  const entry = COMMAND_CATALOG.find((command) => command.name === "compact");
  assert.ok(entry, "/compact must be registered in the shared catalog");
  assert.equal(entry!.handlerId, "compact");
  assert.equal(entry!.usage, "/compact");
  assert.equal(
    "acceptsArguments" in entry!,
    false,
    "/compact is a bare verb: no arguments, nothing to configure here",
  );
  const context = COMMAND_CATALOG.find((command) => command.name === "context");
  assert.equal(entry!.group, "chat");
  assert.equal(entry!.group, context!.group, "/compact belongs beside the window it shortens");
  const compress = COMMAND_CATALOG.find((command) => command.name === "compress");
  assert.equal(compress!.group, "models", "/compress is a model choice and stays in Models");
  const chat = COMMAND_TREE.find((node) => node.name === "Chat");
  assert.ok(chat?.kind === "branch");
  const names = chat.children.map((child) => child.name);
  assert.equal(names.indexOf("compact"), names.indexOf("context") + 1);
  assert.equal(resolveSlashCommand("/compact")?.handlerId, "compact");
});

test("/compact needs a ready route — it is a real, paid compressor call", () => {
  assert.equal(commandRequiresRunnableRoute("compact", []), true);
  assert.equal(commandRequiresRunnableRoute("compact", [], "dashboard"), true);
});

test("bare /compress cross-references /compact instead of pretending to compress", async (t) => {
  const box = await harness({ label: "xref" });
  t.after(box.cleanup);

  await handleSlashCommand("/compress", box.context);

  assert.match(box.lines.join("\n"), /Policy lives here; \/compact runs one compression now\./);
  assert.equal(box.compressor.calls, 0, "/compress must never run the compressor itself");
});

test("/compact folds the chat now, reports what it saved, and books the cost", async (t) => {
  const box = await harness({ label: "happy", turns: 12 });
  t.after(box.cleanup);
  const rawBefore = uncompressedContext(box.session);

  await handleSlashCommand("/compact", box.context);

  assert.equal(box.compressor.calls, 1, "exactly one compressor call");
  assert.equal(
    box.compressor.inputs[0],
    rawBefore,
    "the compressor sees the same context the automatic path would send",
  );
  assert.equal(box.session.data.summary, "Dense handoff: the task, the constraints, the open work.");
  assert.equal(box.session.data.turns.length, 4, "compactTurns(4) keeps the recent turns");
  assert.equal(box.session.data.costs.compressorUsd, 0.002);
  assert.equal(box.session.data.costs.mainUsd, 0);
  assert.equal(box.session.data.costs.totalUsd, 0.002);

  const printed = box.lines.join("\n");
  assert.match(printed, /Compacted: 8 turns folded into the handoff/);
  assert.match(printed, new RegExp(String(rawBefore.length)), "the original size is named");
  assert.match(printed, /% smaller/);
  assert.match(printed, /\$0\.00200/);
  assert.match(printed, new RegExp(box.config.compressorModel.replace(/[/.]/g, "\\$&")));

  // Written through, not just held in memory.
  const reopened = await SessionStore.openById(
    box.session.data.workspace,
    box.session.data.id,
    box.session.appHome,
  );
  assert.equal(reopened.data.summary, box.session.data.summary);
  assert.equal(reopened.data.costs.compressorUsd, 0.002);
});

test("/compact refuses an empty chat honestly, before spending anything", async (t) => {
  const box = await harness({ label: "empty" });
  t.after(box.cleanup);

  await handleSlashCommand("/compact", box.context);

  assert.equal(box.compressor.calls, 0, "an empty chat must never reach the model");
  assert.equal(box.session.data.costs.totalUsd, 0);
  assert.equal(box.session.data.summary, "");
  assert.match(box.lines.join("\n"), /Nothing to compress: this chat has no context yet\./);
});

test("/compact reports the pinned-turn refusal in the compressor's own words and changes nothing", async (t) => {
  const box = await harness({
    label: "pinned",
    turns: 10,
    // Long enough that it cannot beat the minimum saving once every pinned
    // turn is added back on the compressed side (Phase 13's pin gate).
    handoff: () => "A handoff that is honestly not much shorter than the chat it came from.",
  });
  t.after(box.cleanup);
  for (const turn of box.session.data.turns) {
    assert.equal(box.session.pinTurn(turn.id!), true);
  }
  const turnsBefore = structuredClone(box.session.data.turns);

  await handleSlashCommand("/compact", box.context);

  assert.equal(box.compressor.calls, 1, "the refusal is the compressor's, measured — not guessed");
  assert.equal(box.session.data.summary, "", "a refused pass must not rewrite the chat");
  assert.deepEqual(box.session.data.turns, turnsBefore, "every turn survives verbatim");

  const printed = box.lines.join("\n");
  assert.match(printed, /Compression discarded/);
  assert.match(printed, /10 pinned turns held/);
  assert.match(printed, /Nothing was compacted; the chat is unchanged\./);
  // The call happened, so it is booked and said out loud.
  assert.equal(box.session.data.costs.compressorUsd, 0.002);
  assert.match(printed, /still cost \$0\.00200; it is booked/);
});

test("/compact says so plainly when the compressor returns nothing usable", async (t) => {
  const box = await harness({ label: "empty-handoff", turns: 6, handoff: () => "   " });
  t.after(box.cleanup);

  await handleSlashCommand("/compact", box.context);

  assert.equal(box.session.data.summary, "");
  assert.equal(box.session.data.turns.length, 6);
  const printed = box.lines.join("\n");
  assert.match(printed, /Nothing was compacted; the chat is unchanged\./);
  assert.match(printed, /returned nothing usable/);
  assert.equal(box.session.data.costs.compressorUsd, 0.002, "the call is booked either way");
});

test("/compact runs even with compression off — the mode is policy for the automatic path only", async (t) => {
  const box = await harness({
    label: "mode-off",
    turns: 12,
    config: { compressionMode: "off", compressionThresholdChars: 2_000_000 },
  });
  t.after(box.cleanup);

  await handleSlashCommand("/compact", box.context);

  assert.equal(box.compressor.calls, 1);
  assert.equal(box.session.data.turns.length, 4);
  assert.match(box.lines.join("\n"), /Compacted: 8 turns folded/);
});

test("/compact never asks for a confirmation — typing it is the decision (D4)", async (t) => {
  const box = await harness({ label: "no-confirm", turns: 12 });
  t.after(box.cleanup);

  // Every confirm seam on this context throws; reaching the success line at
  // all proves none of them was consulted.
  await handleSlashCommand("/compact", box.context);

  assert.match(box.lines.join("\n"), /Compacted: /);
});
