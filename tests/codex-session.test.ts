import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../src/session.js";
import { WorkspaceGuard, ChangeJournal } from "../src/workspace.js";
import { AgentRunError } from "../src/agent.js";
import { ApprovalManager } from "../src/approval.js";
import type { CodexManagedTurnAuthority, CodexManagedTurnInput, CodexManagedTurnResult } from "../src/codex-managed-turn.js";
import * as sessionModule from "../src/codex-session.js";
import type { RouteIdentityV1 } from "../src/backends.js";

const selectedRoute: RouteIdentityV1 = { version: 1, backendId: "codex", accountFingerprint: "owner-profile",
  billingRealm: "chatgpt-subscription-provider-managed-overage", resolutionState: "resolved",
  canonicalModelId: "gpt-5.3-codex", requestedModelId: "gpt-5.3-codex" };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "orcode-codex-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project"); await mkdir(project);
  const session = SessionStore.create(project, join(root, "home"));
  session.addTurn("user", "Vorherige Frage"); session.addTurn("assistant", "Vorherige Antwort");
  return {
    session, workspace: await WorkspaceGuard.create(project),
    journal: new ChangeJournal({ appHome: session.appHome, chatId: session.data.id }),
    approvals: new ApprovalManager("ask"),
    authority: { binding: { route: selectedRoute }, client: { drain: async () => "closed" } } as unknown as CodexManagedTurnAuthority,
    text: "Neue Aufgabe", observer: {},
  };
}
const ok: CodexManagedTurnResult = { status: "completed", text: "Fertig", publishedPaths: [], cost: "unknown" };

test("Codex session preserves context, streams answer, and persists unknown subscription cost", async (t) => {
  const input = await fixture(t); const deltas: string[] = [];
  const result = await sessionModule.runCodexSessionTurn({ ...input,
    observer: { onText: (text) => deltas.push(text) },
    execute: async (turn: CodexManagedTurnInput) => {
      assert.match(turn.task, /Vorherige Frage/); assert.match(turn.task, /Vorherige Antwort/);
      assert.match(turn.task, /Neue Aufgabe/);
      turn.onEvent({ type: "text", text: "Fertig" }); return ok;
    },
  });
  assert.equal(result.costKnowledge, "unknown"); assert.equal(result.resolvedModel, "gpt-5.3-codex");
  assert.deepEqual(deltas, ["Fertig"]);
  const disk = JSON.parse(await readFile(input.session.path, "utf8"));
  assert.deepEqual(disk.turns.slice(-2).map((x: { content: string }) => x.content), ["Neue Aufgabe", "Fertig"]);
  assert.equal(disk.costs.costKnowledge, "unknown");
});

test("Codex cancellation persists its fragment and throws a cancelled partial result", async (t) => {
  const input = await fixture(t);
  await assert.rejects(sessionModule.runCodexSessionTurn({ ...input,
    execute: async (turn) => { turn.onEvent({ type: "text", text: "Teil" });
      return { ...ok, status: "cancelled", text: "Teil" }; },
  }), (error: unknown) => {
    assert.ok(error instanceof AgentRunError); assert.equal(error.outcome, "cancelled");
    assert.equal(error.result.text, "Teil"); assert.equal(error.result.partial, true); return true;
  });
  const disk = JSON.parse(await readFile(input.session.path, "utf8"));
  assert.equal(disk.turns.at(-1).content, "Teil");
});

test("unexpected runner failure keeps the streamed fragment and cannot become success", async (t) => {
  const input = await fixture(t);
  await assert.rejects(sessionModule.runCodexSessionTurn({ ...input,
    execute: async (turn) => { turn.onEvent({ type: "text", text: "Teil" }); throw new Error("private"); },
  }), (error: unknown) => {
    assert.ok(error instanceof AgentRunError); assert.equal(error.outcome, "error");
    assert.equal(error.result.text, "Teil"); assert.doesNotMatch(error.message, /private/); return true;
  });
});

test("a concurrent chat update is included before Codex can act", async (t) => {
  const input = await fixture(t); await input.session.save();
  const other = await SessionStore.openById(input.session.data.workspace, input.session.data.id, input.session.appHome);
  other.addTurn("user", "NEW OWNER CONSTRAINT: never edit billing.ts"); await other.save();
  const result = await sessionModule.runCodexSessionTurn({ ...input,
    execute: async (turn) => {
      assert.match(turn.task, /NEW OWNER CONSTRAINT: never edit billing.ts/);
      assert.equal(turn.task.split("Neue Aufgabe").length - 1, 1);
      return ok;
    },
  });
  assert.equal(result.outcome, "completed");
  assert.ok(result.notices.some((notice) => /anderen Fenster/.test(notice)));
});

test("failed initial persistence never starts provider work and drains the prepared child", async (t) => {
  const input = await fixture(t); let started = false; let drains = 0;
  input.session.save = async () => { throw new Error("disk-full"); };
  input.authority = { ...input.authority, client: { drain: async () => { drains++; return "closed"; } } } as unknown as CodexManagedTurnAuthority;
  await assert.rejects(sessionModule.runCodexSessionTurn({ ...input,
    execute: async () => { started = true; return ok; },
  }), AgentRunError);
  assert.equal(started, false);
  assert.equal(drains, 1);
});

for (const change of ["clear", "switch"] as const) {
  test(`a concurrent route ${change} revokes Codex dispatch before provider work`, async (t) => {
    const input = await fixture(t); let started = false;
    input.session.setPreferences(selectedRoute.canonicalModelId!, { mode: "auto" }, selectedRoute);
    await input.session.save();
    const other = await SessionStore.openById(input.session.data.workspace, input.session.data.id, input.session.appHome);
    if (change === "clear") await other.clearRouteIfExact(selectedRoute);
    else {
      const next = { ...selectedRoute, canonicalModelId: "other-model", requestedModelId: "other-model" };
      other.setPreferences("other-model", { mode: "auto" }, next); await other.save();
    }
    await assert.rejects(sessionModule.runCodexSessionTurn({ ...input,
      execute: async () => { started = true; return ok; },
    }), AgentRunError);
    assert.equal(started, false);
  });
}
